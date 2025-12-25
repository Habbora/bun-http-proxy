import { ContentRewriter } from "./rewriter";
import { formatPathname } from "./utils/pathname";
import axios from "axios";

export type BunReverseProxyOptions = {
    port: number;
    routes?: Record<string, string>;
    debug?: boolean;
    rewriteContent?: boolean; // Toggle for HTML/CSS rewriting
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

const parseHost = (host: string | null) => {
    if (!host) return { host: "", hostname: "", port: "" };
    const trimmed = host.trim();
    if (!trimmed) return { host: "", hostname: "", port: "" };
    const hostname = trimmed.split(":")[0] ?? trimmed;
    const port = trimmed.includes(":") ? (trimmed.split(":")[1] ?? "") : "";
    return { host: trimmed, hostname, port };
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
                const requestId = ++this.requestSeq;
                const startedAt = performance.now();

                if (req.method.toUpperCase() === "CONNECT") {
                    return new Response("CONNECT not supported", { status: 501 });
                }

                const { hostname } = parseHost(req.headers.get("host"));
                const resolvedHostname = hostname || new URL(req.url).hostname;
                const clientIp = server.requestIP(req)?.address;

                if (!resolvedHostname)
                    return new Response("Bad Request", { status: 400 });

                // Find route
                const target = this.routes[resolvedHostname];
                if (!target) return new Response("Not Found", { status: 404 });

                if (this.options.debug) {
                    console.log("[proxy:req]", {
                        id: requestId,
                        method: req.method,
                        url: req.url,
                        host: req.headers.get("host"),
                        matchedHost: resolvedHostname,
                        target,
                        clientIp,
                        headers: headersToLogObject(req.headers),
                    });
                }

                try {
                    return await this.proxy(req, target, requestId, startedAt, resolvedHostname, clientIp);
                } catch (error) {
                    console.error("[proxy:error]", error);
                    return new Response("Bad Gateway", { status: 502 });
                }
            },
        });
    };

    private proxy = async (
        req: Request,
        target: string,
        requestId: number,
        startedAt: number,
        matchedHost: string,
        clientIp?: string
    ) => {
        // Build Upstream URL
        const incomingUrl = new URL(req.url);
        const upstreamUrl = new URL(target);
        const basePath = upstreamUrl.pathname === "/" ? "" : upstreamUrl.pathname.replace(/\/$/, "");

        // Path rewriting: /foo -> /basePath/foo
        upstreamUrl.pathname = formatPathname(basePath + incomingUrl.pathname);
        upstreamUrl.search = incomingUrl.search;
        upstreamUrl.hash = incomingUrl.hash;

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
        const clientHost = req.headers.get("host") || incomingUrl.host;
        const proto = incomingUrl.protocol.replace(":", "");
        if (clientHost) {
            upstreamHeaders["x-forwarded-host"] = clientHost;
            upstreamHeaders["x-forwarded-proto"] = proto;
            upstreamHeaders["x-forwarded-server"] = matchedHost;
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
                if (originUrl.hostname === matchedHost) upstreamHeaders["origin"] = upstreamUrl.origin;
            } catch { }
        }

        if (this.options.debug) {
            console.log("[proxy:upstream:req]", {
                id: requestId,
                url: upstreamUrl.toString(),
                headers: headersToLogObject(upstreamHeaders),
            });
        }

        // Use Axios instead of Fetch for better stability with legacy servers/chunked encoding
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
        const clientOrigin = `${incomingUrl.protocol}//${clientHost}`;
        if (location) {
            try {
                const resolvedLoc = new URL(location, upstreamUrl);
                // Only rewrite if it points to the upstream
                if (resolvedLoc.origin === upstreamUrl.origin) {
                    const clientLoc = new URL(clientOrigin);
                    clientLoc.pathname = stripBasePath(resolvedLoc.pathname, basePath);
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
                    rewriteSetCookieForClient(cookie, matchedHost, basePath)
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
                 const rewriter = new ContentRewriter(upstreamUrl.origin, clientOrigin, basePath);
                 downstreamRes = rewriter.transform(downstreamRes);
            }
        }

        // Debug Headers
        if (this.options.debug) {
            const durationMs = performance.now() - startedAt;
            downstreamRes.headers.set("x-bun-proxy-id", String(requestId));
            downstreamRes.headers.set("x-bun-proxy-upstream", upstreamUrl.origin);
            downstreamRes.headers.set("x-bun-proxy-time", durationMs.toFixed(1));

            console.log("[proxy:upstream:res]", {
                id: requestId,
                status: upstreamRes.status,
                headers: headersToLogObject(downstreamHeaders),
                duration: durationMs.toFixed(1) + "ms"
            });
        }

        return downstreamRes;
    };
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
