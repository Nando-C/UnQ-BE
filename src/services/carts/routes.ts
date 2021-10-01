import { Router } from "express"
import { JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"

const router = Router()

router.post("/", JWTAuthMiddleware, controllers.createCart)
router.get("/", JWTAuthMiddleware, controllers.getMyCarts)
router.get("/:cartId", JWTAuthMiddleware, controllers.getMySingleCart)

export default router