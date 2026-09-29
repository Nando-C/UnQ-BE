// ===================== PACKAGES ===================================
import express from "express"
import cors from "cors"
import passport from "passport"
import googleStrategy from "./services/auth/oauth"
import cookieParser from "cookie-parser"

import { errorsHandler } from "./errorMiddlewares"
import { corsOptions } from "./settings/cors"

// ===================== ROUTERS ====================================
import authRouter from "./services/auth/routes"
import userRouter from "./services/users/routes"
import shopRouter from "./services/shops/routes"
import menuRouter from "./services/menus/routes"
import cartRouter from "./services/carts/routes"


const app = express()
passport.use("google", googleStrategy)

// ===================== MIDDLEWARES ================================
app.use(express.json())
// Behind the host's proxy: trust its X-Forwarded-* headers (client IP, https).
app.set('trust proxy', 1)
app.use(cors(corsOptions))
app.use(cookieParser())
app.use(passport.initialize())

// ===================== ENDPOINTS  =================================
app.use("/auth", authRouter)
app.use("/users", userRouter)
app.use("/shops", shopRouter)
// Menu routes live under /shops/:shopId/menu, next to the shop routes.
app.use("/shops", menuRouter)
app.use("/carts", cartRouter)

// ===================== ERROR HANDLERS =============================
app.use(errorsHandler)

export default app