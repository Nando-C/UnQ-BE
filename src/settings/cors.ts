import cors from "cors"
import { Request } from "express"
import env from "./env"

const whiteList = env.CORS_WHITELIST

// The origin this request was sent to, as the browser saw it (behind the
// host's proxy, from X-Forwarded-*: server.ts trusts it). A page this server
// serves itself, Swagger UI at /docs, calls the API on it.
const ownOrigin = (req: Request) => `${req.protocol}://${req.get("host")}`

// Per request: the front-end origins, and the server's own.
export const corsOptions: cors.CorsOptionsDelegate<Request> = (req, callback) => {
    const origin = req.headers.origin
    // No Origin header: not a browser's cross-site request (curl, server-to-server).
    if (!origin || whiteList.includes(origin) || origin === ownOrigin(req)) {
        callback(null, { origin: true, credentials: true })
    } else {
        callback(new Error("Not Allowed By Cors!"))
    }
}
