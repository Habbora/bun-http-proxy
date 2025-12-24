type Route = {
  target: string;
  private?: boolean;
}

const routes = new Map<string, Route>([
  ["spresso.vpn.habbora.com.br", { target: "http://localhost:8080" }],
  ["logic.vpn.habbora.com.br", { target: "http://localhost:8081" }],
])

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

const buildUpstreamUrl = (req: Request, route: Route) => {
  const incomingUrl = new URL(req.url);
  const upstreamUrl = new URL(route.target);

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

const buildUpstreamHeaders = (req: Request, upstreamUrl: URL) => {
  const headers = new Headers(req.headers)
  headers.set("host", upstreamUrl.host)

  for (const name of hopByHopHeaderNames) headers.delete(name)
  headers.delete("content-length");

  return headers
}

const proxy = (req: Request, route: Route) => {
  const upstreamUrl = buildUpstreamUrl(req, route)
  const headers = buildUpstreamHeaders(req, upstreamUrl)
  const method = req.method.toUpperCase()
  const body = method === "GET" || method === "HEAD" ? undefined : req.body

  return fetch(upstreamUrl, {
    method,
    headers,
    body,
    redirect: "manual",
  })
}



export const startReverseProxy = (options?: { port?: number }) => {
  const port = options?.port ?? 3000

  return Bun.serve({
    port,

    async fetch(req) {
      if (req.method.toUpperCase() === "CONNECT") {
        return new Response("CONNECT not supported", { status: 501 })
      }

      const host = req.headers.get("host")
      if (!host) return new Response("Bad Request", { status: 400 })

      const hostname = host.split(":")[0] ?? host
      const route = routes.get(hostname)
      if (!route) return new Response("Not Found", { status: 404 })

      try {
        return await proxy(req, route)
      } catch {
        return new Response("Bad Gateway", { status: 502 })
      }
    },
  })
}
