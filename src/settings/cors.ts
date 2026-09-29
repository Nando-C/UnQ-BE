import cors from "cors"
import env from "./env"

const whiteList = env.CORS_WHITELIST

export const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
        // No Origin header: not a browser's cross-site request (curl, server-to-server).
        if (!origin || whiteList.indexOf(origin) !== -1) {
            callback(null, true)
        } else {
            callback(new Error("Not Allowed By Cors!"))
        }
    },
    credentials: true,
}