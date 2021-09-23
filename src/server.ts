// ===================== Packages =============================
import express from "express"
import cors from "cors"

import { errorsHandler } from "./errorMddlewares"

// ===================== Routers =============================
import authRouter from "./auth/routes"


const app = express()

// ===================== MIDDLEWARES =============================
app.use(cors())
app.use(express.json())

// ===================== ENDPOINTS  =================================
app.use("/auth", authRouter)
// ===================== ERROR HANDLERS ==========================
app.use(errorsHandler)

export default app