import { Router } from "express"
import { JWTAuthMiddleware, optionalJWT } from "../auth/middlewares"
import * as controllers from "./controllers"
import { validate } from "../../middlewares/validate"
import { cartEditLimit } from "../../middlewares/rateLimits"
import { cartItemSchema, cartItemWithQtySchema, checkOutSplitSchema } from "./schemas"

const router = Router()

// A diner changing a table's order: signed in, and within the edit limit.
const editing = [JWTAuthMiddleware, cartEditLimit]

router.post("/:shopId/tables/:tableId/addItem", editing, validate(cartItemWithQtySchema), controllers.addItem)
router.post("/:shopId/tables/:tableId/removeItem", editing, validate(cartItemWithQtySchema), controllers.decreaseItem)
router.post("/:shopId/tables/:tableId/deleteItem", editing, validate(cartItemSchema), controllers.deleteItem)
router.post("/:shopId/tables/:tableId/:cartId/addSplitItem", editing, validate(cartItemWithQtySchema), controllers.addSplitItem)
router.post("/:shopId/tables/:tableId/:cartId/decreaseSplitItem", editing, validate(cartItemSchema), controllers.decreaseSplitItem)
router.post("/:shopId/tables/:tableId/:cartId/removeSplitItem", editing, validate(cartItemSchema), controllers.removeSplitItem)
router.post("/tables/:tableId/:cartId/createCheckoutOrder", JWTAuthMiddleware, controllers.createCheckoutOrder)
router.post("/tables/:tableId/:cartId/captureCheckout", JWTAuthMiddleware, validate(checkOutSplitSchema), controllers.captureCheckout)
// Public (anyone at the table); a signed-in diner also gets their own notices.
router.get("/tables/:tableId", optionalJWT, controllers.getTableCart)
router.get("/", JWTAuthMiddleware, controllers.getMyCarts)
router.get("/:cartId", JWTAuthMiddleware, controllers.getSingleCart)

export default router