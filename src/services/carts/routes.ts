import { Router } from "express"
import { JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"

const router = Router()

router.post("/", JWTAuthMiddleware, controllers.createCart)
router.post("/:shopId/tables/:tableId/addItem", JWTAuthMiddleware, controllers.addItem)
router.post("/:shopId/tables/:tableId/removeItem", JWTAuthMiddleware, controllers.decreaseItem)
router.post("/:shopId/tables/:tableId/:cardId", JWTAuthMiddleware, controllers.addSplitItem)
router.get("/", JWTAuthMiddleware, controllers.getMyCarts)
router.get("/:cartId", JWTAuthMiddleware, controllers.getSingleCart)

export default router