import { Router } from "express"
import { JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"

const router = Router()

// Me Routes
router.get("/me", JWTAuthMiddleware, controllers.getMe)
router.put("/me", JWTAuthMiddleware, controllers.editMe)
router.delete("/me", JWTAuthMiddleware, controllers.deleteMe)

export default router