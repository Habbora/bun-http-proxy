import { ContentRewriter } from "./rewriter";
import { formatPathname } from "./utils/pathname";
import axios from "axios";

export type BunReverseProxyOptions = {
    port: number;
    routes?: Record<string, string>;
    debug?: boolean;
    rewriteContent?: boolean;
};

const hopByHopHeaderNames = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
]);

const redactedHeaderNames = new Set([
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
]);

const deleteConnectionListedHeaders = (headers: Headers) => {
    const connection = headers.get("connection");
    if (!connection) return;

    for (const name of connection.split(",")) {
        const normalized = name.trim().toLowerCase();
        if (normalized) headers.delete(normalized);
    }
};

const headersToLogObject = (headers: Headers | Record<string, any>) => {
    const out: Record<string, string> = {};
    const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);

    for (const [name, value] of entries) {
        const key = name.toLowerCase();
        out[name] = redactedHeaderNames.has(key) ? "[redacted]" : String(value);
    }
    return out;
};

const stripBasePath = (pathname: string, basePath: string) => {
    if (!basePath) return pathname || "/";
    if (pathname === basePath) return "/";
    if (pathname.startsWith(basePath + "/"))
        return pathname.slice(basePath.length) || "/";
    return pathname || "/";
};

const rewriteSetCookieForClient = (
    setCookie: string,
    clientHostname: string,
    basePath: string,
) => {
    const parts = setCookie.split(";");
    const head = parts.shift();
    if (!head) return setCookie;

    const attrs = parts.map((p) => p.trim()).filter(Boolean);
    const rewrittenAttrs: string[] = [];

    for (const attr of attrs) {
        const eqIndex = attr.indexOf("=");
        const key = (eqIndex === -1 ? attr : attr.slice(0, eqIndex))
            .trim()
            .toLowerCase();
        const value = eqIndex === -1 ? "" : attr.slice(eqIndex + 1).trim();

        if (key === "domain" && clientHostname) {
            rewrittenAttrs.push(`Domain=${clientHostname}`);
            continue;
        }

        if (key === "path") {
            const newPath = stripBasePath(value || "/", basePath);
            rewrittenAttrs.push(`Path=${newPath}`);
            continue;
        }

        rewrittenAttrs.push(attr);
    }

    return [head.trim(), ...rewrittenAttrs].join("; ");
};

export class BunReverseProxy {
    private server: Bun.Server<any>;
    private routes: Record<string, string>;
    private requestSeq = 0;

    constructor(public readonly options: BunReverseProxyOptions) {
        this.routes = options.routes || {};
        this.server = this.createServer();
    }

    public get port() {
        return this.server.port;
    }

    public stop(force = false) {
        this.server.stop(force);
    }

    private createServer = () => {
        return Bun.serve({
            port: this.options.port,
            fetch: async (req, server) => {
                return await this.fetchHandle(req, server);
            },
        });
    };

    private fetchHandle = async (req: Request, server: Bun.Server<any>): Promise<Response> => {
        const requestId = ++this.requestSeq;
        const startedAt = performance.now();

        if (req.method.toLowerCase() === "connect") {
            return new Response("connect not supported", { status: 501 });
        }

        const requestURL = new URL(req.url);
        const requestHostname = requestURL.hostname || req.headers.get("host");
        if (!requestHostname) return new Response("Bad Request", { status: 400 });
        const clientIp = server.requestIP(req)?.address;

        // Find route by hostname
        const target = this.routes[requestHostname];
        if (!target) return new Response("Not Found", { status: 404 });

        if (this.options.debug) {
            console.log("[client:req]", {
                id: requestId,
                request: req.clone()
            });
        }

        const upstreamUrl = new URL(target);
        // Path rewriting: /foo -> /basePath/foo
        upstreamUrl.pathname = formatPathname(upstreamUrl.pathname + requestURL.pathname);
        upstreamUrl.search = requestURL.search;
        upstreamUrl.hash = requestURL.hash;

        // Build Upstream Headers
        const upstreamHeaders: Record<string, string> = {};
        req.headers.forEach((value, key) => {
            if (!hopByHopHeaderNames.has(key.toLowerCase())) {
                upstreamHeaders[key] = value;
            }
        });

        upstreamHeaders["host"] = upstreamUrl.host;

        // Disable compression to allow rewriting
        delete upstreamHeaders["accept-encoding"];

        // Remove headers that might cause 304 Not Modified
        delete upstreamHeaders["if-none-match"];
        delete upstreamHeaders["if-modified-since"];

        // Forwarding headers
        const clientHost = req.headers.get("host") || requestURL.host;
        const proto = requestURL.protocol.replace(":", "");
        if (clientHost) {
            upstreamHeaders["x-forwarded-host"] = clientHost;
            upstreamHeaders["x-forwarded-proto"] = proto;
            upstreamHeaders["x-forwarded-server"] = requestHostname;
        }
        if (clientIp) {
            const prev = upstreamHeaders["x-forwarded-for"];
            upstreamHeaders["x-forwarded-for"] = prev ? `${prev}, ${clientIp}` : clientIp;
        }

        // Fix Origin/Referer
        const origin = upstreamHeaders["origin"];
        if (origin) {
            try {
                const originUrl = new URL(origin);
                if (originUrl.hostname === requestHostname) upstreamHeaders["origin"] = upstreamUrl.origin;
            } catch { }
        }

        if (this.options.debug) {
            console.log("[proxy:req]", {
                id: requestId,
                url: upstreamUrl.toString(),
                headers: headersToLogObject(upstreamHeaders),
            });
        }

        let upstreamRes;
        let responseBody: ArrayBuffer;

        try {
            // Read body from request if present
            let body = null;
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                body = await req.arrayBuffer();
            }

            const axiosResponse = await axios({
                method: req.method,
                url: upstreamUrl.toString(),
                headers: upstreamHeaders,
                data: body,
                responseType: 'arraybuffer', // Force buffer
                validateStatus: () => true, // Don't throw on 4xx/5xx
                maxRedirects: 0, // Manual redirect handling
            });

            upstreamRes = {
                status: axiosResponse.status,
                statusText: axiosResponse.statusText,
                headers: new Headers(axiosResponse.headers as any)
            };
            responseBody = axiosResponse.data;

        } catch (err: any) {
            console.error("Axios Error:", err.message);
            return new Response("Proxy Error", { status: 502 });
        }

        // Build Downstream Response
        const downstreamHeaders = new Headers(upstreamRes.headers);
        deleteConnectionListedHeaders(downstreamHeaders);
        for (const name of hopByHopHeaderNames) downstreamHeaders.delete(name);

        // Fix Location Header
        const location = downstreamHeaders.get("location");
        const clientOrigin = `${requestURL.protocol}//${clientHost}`;
        if (location) {
            try {
                const resolvedLoc = new URL(location, upstreamUrl);
                // Only rewrite if it points to the upstream
                if (resolvedLoc.origin === upstreamUrl.origin) {
                    const clientLoc = new URL(clientOrigin);
                    clientLoc.pathname = stripBasePath(resolvedLoc.pathname, requestURL.pathname);
                    clientLoc.search = resolvedLoc.search;
                    clientLoc.hash = resolvedLoc.hash;
                    downstreamHeaders.set("location", clientLoc.toString());
                }
            } catch { }
        }

        // Fix Set-Cookie
        const setCookies = upstreamRes.headers.getAll("set-cookie");
        if (setCookies.length > 0) {
            downstreamHeaders.delete("set-cookie");
            for (const cookie of setCookies) {
                downstreamHeaders.append(
                    "set-cookie",
                    rewriteSetCookieForClient(cookie, requestHostname, requestURL.pathname)
                );
            }
        }

        let downstreamRes = new Response(responseBody, {
            status: upstreamRes.status,
            statusText: upstreamRes.statusText,
            headers: downstreamHeaders,
        });

        // Content Rewriting
        if (this.options.rewriteContent !== false) {
            if (this.options.rewriteContent) {
                const rewriter = new ContentRewriter(upstreamUrl.origin, clientOrigin, requestURL.pathname);
                downstreamRes = rewriter.transform(downstreamRes);
            }
        }

        // Debug Headers
        if (this.options.debug) {
            downstreamRes.headers.set("x-bun-proxy-id", String(requestId));
            downstreamRes.headers.set("x-bun-proxy-upstream", upstreamUrl.origin);

            console.log("[proxy:upstream:res]", {
                id: requestId,
                status: upstreamRes.status,
                headers: headersToLogObject(downstreamHeaders),
            });
        }

        return downstreamRes;
    }
}

if (import.meta.main) {
    const port = process.env.PORT ? Number(process.env.PORT) : 3000;
    const debug = process.env.DEBUG !== "false";

    // Example usage
    const proxy = new BunReverseProxy({
        port,
        debug,
        rewriteContent: true, // Enable rewriting by default in standalone mode
        routes: {
            "localhost": "https://www.uol.com.br",
            "example.org": "http://localhost:8081",
        },
    });

    console.log(`Reverse proxy listening on http://localhost:${proxy.port}`);
}
