import { Router } from "express"
import { JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"
import { validate } from "../../middlewares/validate"
import { cartItemSchema, cartItemWithQtySchema, checkOutSplitSchema } from "./schemas"

const router = Router()

router.post("/:shopId/tables/:tableId/addItem", JWTAuthMiddleware, validate(cartItemWithQtySchema), controllers.addItem)
router.post("/:shopId/tables/:tableId/removeItem", JWTAuthMiddleware, validate(cartItemWithQtySchema), controllers.decreaseItem)
router.post("/:shopId/tables/:tableId/deleteItem", JWTAuthMiddleware, validate(cartItemSchema), controllers.deleteItem)
router.post("/:shopId/tables/:tableId/:cartId/addSplitItem", JWTAuthMiddleware, validate(cartItemWithQtySchema), controllers.addSplitItem)
router.post("/:shopId/tables/:tableId/:cartId/decreaseSplitItem", JWTAuthMiddleware, validate(cartItemSchema), controllers.decreaseSplitItem)
router.post("/:shopId/tables/:tableId/:cartId/removeSplitItem", JWTAuthMiddleware, validate(cartItemSchema), controllers.removeSplitItem)
router.post("/tables/:tableId/:cartId/checkOutSplitItem", JWTAuthMiddleware, validate(cartItemWithQtySchema), controllers.checkOutSplitItem)
router.post("/tables/:tableId/:cartId/checkOutSplit", JWTAuthMiddleware, validate(checkOutSplitSchema), controllers.checkOutSplit)
router.get("/tables/:tableId", controllers.getTableCart)
router.get("/", JWTAuthMiddleware, controllers.getMyCarts)
router.get("/:cartId", JWTAuthMiddleware, controllers.getSingleCart)

export default router