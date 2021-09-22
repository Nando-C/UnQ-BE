// ===================== Packages =============================
import express from "express"
import cors from "cors"

import { errorsHandler } from "./errorMddlewares"

// ===================== Routers =============================

const app = express()

// ===================== MIDDLEWARES =============================
app.use(cors())
app.use(express.json())

// ===================== ENDPOINTS  =================================

// ===================== ERROR HANDLERS ==========================
app.use(errorsHandler)

export default app