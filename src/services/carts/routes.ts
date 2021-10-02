import { Router } from "express"
import { JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"

const router = Router()

router.post("/", JWTAuthMiddleware, controllers.createCart)
router.post("/:shopId/tables/:tableId/addItem", JWTAuthMiddleware, controllers.addItem)
router.post("/:shopId/tables/:tableId/removeItem", JWTAuthMiddleware, controllers.decreaseItem)
router.post("/:shopId/tables/:tableId/:cartId/addSplitItem", JWTAuthMiddleware, controllers.addSplitItem)
router.post("/:shopId/tables/:tableId/:cartId/removeSplitItem", JWTAuthMiddleware, controllers.removeSplitItem)
router.get("/", JWTAuthMiddleware, controllers.getMyCarts)
router.get("/:cartId", JWTAuthMiddleware, controllers.getSingleCart)

export default router