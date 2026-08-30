import cors from "cors"
import env from "./env"

const whiteList = env.CORS_WHITELIST

export const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
        if (!origin || whiteList.indexOf(origin) !== -1) {
            callback(null, true)
        } else {
            callback(new Error("Not Allowed By Cors!"))
        }
    },
    credentials: true,
}