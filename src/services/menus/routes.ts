import { Router } from "express"
import { menuItemImageParser } from "../../settings/cloudinary"
import { isShopManager, JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"
import { validate } from "../../middlewares/validate"
import { createMenuItemSchema, editMenuItemSchema } from "./schemas"

const router = Router()

router.post("/:shopId/menu", JWTAuthMiddleware, isShopManager, validate(createMenuItemSchema), controllers.createItem)
router.get("/:shopId/menu", JWTAuthMiddleware, controllers.getMenuList)
router.get("/:shopId/menu/:itemId", JWTAuthMiddleware, controllers.getMenuItem)
router.put("/:shopId/menu/:itemId", JWTAuthMiddleware, isShopManager, validate(editMenuItemSchema), controllers.editItem)
router.put("/:shopId/menu/:itemId/img", JWTAuthMiddleware, isShopManager, menuItemImageParser.single("image"), controllers.editItemImage)
router.delete("/:shopId/menu/:itemId", JWTAuthMiddleware, isShopManager, controllers.deleteItem)

export default router