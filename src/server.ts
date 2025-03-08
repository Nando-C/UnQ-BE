// ===================== PACKAGES ===================================
import express from "express"
import cors from "cors"
import passport from "passport"
import googleStrategy from "./services/auth/oauth"
import cookieParser from "cookie-parser"
import session from "express-session"

import { errorsHandler } from "./errorMddlewares"
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
app.set('trust proxy', 1)
app.use(session({ secret: 'bat smash cat', resave: true, saveUninitialized: true }))
app.use(cors(corsOptions))
app.use(cookieParser())
app.use(passport.initialize())

// ===================== ENDPOINTS  =================================
app.use("/auth", authRouter)
app.use("/users", userRouter)
app.use("/shops", shopRouter)
app.use("/shops", menuRouter)
app.use("/carts", cartRouter)

// ===================== ERROR HANDLERS =============================
app.use(errorsHandler)

export default app