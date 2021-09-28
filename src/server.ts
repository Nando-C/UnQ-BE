// ===================== Packages =============================
import express from "express"
import cors from "cors"
import passport from "passport"
import googleStrategy from "./services/auth/oauth"
import cookieParser from "cookie-parser"

import { errorsHandler } from "./errorMddlewares"
import { corsOptions } from "./settings/cors"

// ===================== Routers =============================
import authRouter from "./services/auth/routes"
import userRouter from "./services/users/routes"


const app = express()
passport.use("google", googleStrategy)

// ===================== MIDDLEWARES =============================
app.use(express.json())
app.use(cors(corsOptions))
app.use(cookieParser())
app.use(passport.initialize())

// ===================== ENDPOINTS  =================================
app.use("/auth", authRouter)
app.use("/users", userRouter)

// ===================== ERROR HANDLERS ==========================
app.use(errorsHandler)

export default app