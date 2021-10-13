import { Router } from "express"
import { JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"

const router = Router()

router.post("/:shopId/tables/:tableId/addItem", JWTAuthMiddleware, controllers.addItem)
router.post("/:shopId/tables/:tableId/removeItem", JWTAuthMiddleware, controllers.decreaseItem)
router.post("/:shopId/tables/:tableId/:cartId/addSplitItem", JWTAuthMiddleware, controllers.addSplitItem)
router.post("/:shopId/tables/:tableId/:cartId/decreaseSplitItem", JWTAuthMiddleware, controllers.decreaseSplitItem)
router.post("/:shopId/tables/:tableId/:cartId/removeSplitItem", JWTAuthMiddleware, controllers.removeSplitItem)
router.post("/tables/:tableId/:cartId/checkOutSplitItem", JWTAuthMiddleware, controllers.checkOutSplitItem)
router.get("/tables/:tableId", JWTAuthMiddleware, controllers.getTableCart)
router.get("/", JWTAuthMiddleware, controllers.getMyCarts)
router.get("/:cartId", JWTAuthMiddleware, controllers.getSingleCart)

export default router