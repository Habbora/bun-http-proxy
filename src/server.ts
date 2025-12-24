export type Route = {
    target: string
    private?: boolean
}

export type RoutesInput =
    | Record<string, string | Route>
    | Map<string, string | Route>

export type BunReverseProxyOptions = {
    port: number
    routes?: RoutesInput
}

const hopByHopHeaderNames = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
])

const normalizeRoutes = (routes?: RoutesInput) => {
    const out = new Map<string, Route>()
    if (!routes) return out

    if (routes instanceof Map) {
        for (const [host, value] of routes.entries()) {
            out.set(host, typeof value === "string" ? { target: value } : value)
        }
        return out
    }

    for (const [host, value] of Object.entries(routes)) {
        out.set(host, typeof value === "string" ? { target: value } : value)
    }

    return out
}

export class BunReverseProxy {
    private server: Bun.Server<any>
    private routes: Map<string, Route>

    constructor(public readonly options: BunReverseProxyOptions) {
        this.routes = normalizeRoutes(options.routes)
        this.server = this.createServer()
    }

    get port() {
        return this.server.port
    }

    stop(force = false) {
        this.server.stop(force)
    }

    setRoutes(routes: RoutesInput) {
        this.routes = normalizeRoutes(routes)
    }

    addRoute(hostname: string, route: string | Route) {
        this.routes.set(
            hostname,
            typeof route === "string" ? { target: route } : route,
        )
    }

    private createServer = () => {
        return Bun.serve({
            port: this.options.port,

            fetch: async (req) => {
                if (req.method.toUpperCase() === "CONNECT") {
                    return new Response("CONNECT not supported", { status: 501 })
                }

                const host = req.headers.get("host")
                const hostname = (host?.split(":")[0] ?? host) || new URL(req.url).hostname
                if (!hostname) return new Response("Bad Request", { status: 400 })

                const route = this.routes.get(hostname)
                if (!route) return new Response("Not Found", { status: 404 })

                try {
                    return await this.proxy(req, route)
                } catch {
                    return new Response("Bad Gateway", { status: 502 })
                }
            },
        })
    }

    private proxy = (req: Request, route: Route) => {
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

    private buildUpstreamUrl = (req: Request, route: Route) => {
        const incomingUrl = new URL(req.url)
        const upstreamUrl = new URL(route.target)

        const basePath =
            upstreamUrl.pathname === "/"
                ? ""
                : upstreamUrl.pathname.endsWith("/")
                    ? upstreamUrl.pathname.slice(0, -1)
                    : upstreamUrl.pathname

        upstreamUrl.pathname = `${basePath}${incomingUrl.pathname}`
        upstreamUrl.search = incomingUrl.search
        upstreamUrl.hash = incomingUrl.hash

        return upstreamUrl
    }

    private buildUpstreamHeaders = (req: Request, upstreamUrl: URL) => {
        const headers = new Headers(req.headers)
        headers.set("host", upstreamUrl.host)

        for (const name of hopByHopHeaderNames) headers.delete(name)
        headers.delete("content-length")

        return headers
    }
}
