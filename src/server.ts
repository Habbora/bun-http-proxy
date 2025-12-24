export class BunReverseProxy {
    private server: Bun.Server<any>
    private routes: Record<string, string> = {}
    private hopByHopHeaderNames = new Set([
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
    ])

    constructor(public readonly port: number) {
        this.server = this.createServer()
    }

    private createServer = () => {
        return Bun.serve({
            port: this.port,

            fetch: async (req) => {
                if (req.method.toUpperCase() === "CONNECT") {
                    return new Response("CONNECT not supported", { status: 501 })
                }

                const host = req.headers.get("host")
                if (!host) return new Response("Bad Request", { status: 400 })

                const hostname = host.split(":")[0] ?? host
                const route = this.routes[hostname]
                if (!route) return new Response("Not Found", { status: 404 })

                try {
                    return await this.proxy(req, route)
                } catch {
                    return new Response("Bad Gateway", { status: 502 })
                }
            }
        })
    }

    private proxy = (req: Request, route: string) => {
        const upstreamUrl = this.buildUpstreamUrl(req, route)
        const headers = this.buildUpstreamHeaders(req, upstreamUrl)
        const method = req.method.toUpperCase()
        const body = method === "GET" || method === "HEAD" ? undefined : req.body

        return fetch(upstreamUrl, {
            method,
            headers,
            body,
            redirect: "manual",
        })
    }

    private buildUpstreamUrl = (req: Request, route: string) => {
        const incomingUrl = new URL(req.url);
        const upstreamUrl = new URL(route);

        const basePath =
            upstreamUrl.pathname === "/"
                ? ""
                : upstreamUrl.pathname.endsWith("/")
                    ? upstreamUrl.pathname.slice(0, -1)
                    : upstreamUrl.pathname

        upstreamUrl.pathname = `${basePath}${incomingUrl.pathname}`
        upstreamUrl.search = incomingUrl.search
        upstreamUrl.hash = incomingUrl.hash

        return upstreamUrl;
    }

    private buildUpstreamHeaders = (req: Request, upstreamUrl: URL) => {
        const headers = new Headers(req.headers)
        headers.set("host", upstreamUrl.host)

        for (const name of this.hopByHopHeaderNames) headers.delete(name)
        headers.delete("content-length");

        return headers
    }
}
