// ===================== Packages =============================
import express from "express"
import cors from "cors"

import { errorsHandler } from "./errorMddlewares"
import { corsOptions } from "./settings/cors"

// ===================== Routers =============================
import authRouter from "./services/auth/routes"


const app = express()

// ===================== MIDDLEWARES =============================
app.use(express.json())
app.use(cors(corsOptions))

// ===================== ENDPOINTS  =================================
app.use("/auth", authRouter)
// ===================== ERROR HANDLERS ==========================
app.use(errorsHandler)

export default app