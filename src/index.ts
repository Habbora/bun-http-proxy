import { BunReverseProxy } from "./server"

const port = process.env.PORT ? Number(process.env.PORT) : 3000
const server = new BunReverseProxy(port)

console.log(`Reverse proxy listening on http://localhost:${server.port}`)
