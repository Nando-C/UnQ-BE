import { Router } from "express"
import { menuItemImageUpload } from "../../settings/cloudinary"
import { isShopManager, JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"
import { validate } from "../../middlewares/validate"
import { createMenuItemSchema, editMenuItemSchema } from "./schemas"

const router = Router()

router.post("/:shopId/menu", JWTAuthMiddleware, isShopManager, validate(createMenuItemSchema), controllers.createItem)
router.get("/:shopId/menu", JWTAuthMiddleware, controllers.getMenuList)
router.get("/:shopId/menu/:itemId", JWTAuthMiddleware, controllers.isOnShopMenu, controllers.getMenuItem)
router.put("/:shopId/menu/:itemId", JWTAuthMiddleware, isShopManager, controllers.isOnShopMenu, validate(editMenuItemSchema), controllers.editItem)
// Both checks run before the upload, so a refused request never reaches Cloudinary.
router.put("/:shopId/menu/:itemId/img", JWTAuthMiddleware, isShopManager, controllers.isOnShopMenu, menuItemImageUpload, controllers.editItemImage)
router.delete("/:shopId/menu/:itemId", JWTAuthMiddleware, isShopManager, controllers.deleteItem)

export default router