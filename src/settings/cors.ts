import cors from "cors"

const whiteList = [process.env.FRONTEND_DEV_URL, process.env.FRONTEND_PROD_URL]

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