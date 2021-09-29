import { Router } from "express"
import { adminOnly, JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"

const router = Router()

router.post("/", JWTAuthMiddleware, adminOnly, controllers.createShop)

export default router