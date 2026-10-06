import { Router } from "express"
import { JWTAuthMiddleware, optionalJWT } from "../auth/middlewares"
import * as controllers from "./controllers"
import { validate } from "../../middlewares/validate"
import { cartEditLimit } from "../../middlewares/rateLimits"
import { cartItemSchema, cartItemWithQtySchema, checkOutSplitSchema } from "./schemas"

const router = Router()

router.post("/:shopId/tables/:tableId/addItem", JWTAuthMiddleware, cartEditLimit, validate(cartItemWithQtySchema), controllers.addItem)
router.post("/:shopId/tables/:tableId/removeItem", JWTAuthMiddleware, cartEditLimit, validate(cartItemWithQtySchema), controllers.decreaseItem)
router.post("/:shopId/tables/:tableId/deleteItem", JWTAuthMiddleware, cartEditLimit, validate(cartItemSchema), controllers.deleteItem)
router.post("/:shopId/tables/:tableId/:cartId/addSplitItem", JWTAuthMiddleware, cartEditLimit, validate(cartItemWithQtySchema), controllers.addSplitItem)
router.post("/:shopId/tables/:tableId/:cartId/decreaseSplitItem", JWTAuthMiddleware, cartEditLimit, validate(cartItemSchema), controllers.decreaseSplitItem)
router.post("/:shopId/tables/:tableId/:cartId/removeSplitItem", JWTAuthMiddleware, cartEditLimit, validate(cartItemSchema), controllers.removeSplitItem)
router.post("/tables/:tableId/:cartId/createCheckoutOrder", JWTAuthMiddleware, controllers.createCheckoutOrder)
router.post("/tables/:tableId/:cartId/captureCheckout", JWTAuthMiddleware, validate(checkOutSplitSchema), controllers.captureCheckout)
// Public (anyone at the table); a signed-in diner also gets their own notices.
router.get("/tables/:tableId", optionalJWT, controllers.getTableCart)
router.get("/", JWTAuthMiddleware, controllers.getMyCarts)
router.get("/:cartId", JWTAuthMiddleware, controllers.getSingleCart)

export default router