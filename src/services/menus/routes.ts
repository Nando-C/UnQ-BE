import { Router } from "express"
import { menuItemImageUpload } from "../../settings/cloudinary"
import { allows, allowsMenuChange, isShopManager, JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"
import { validate } from "../../middlewares/validate"
import { createMenuItemSchema, editMenuItemSchema } from "./schemas"

const router = Router()

// Who may do what on a shop is by ability (shops/roles.ts): editing the menu
// is the owner's and managers'; the availability switch is every member's.
router.post("/:shopId/menu", JWTAuthMiddleware, isShopManager, allows("menu.edit"), validate(createMenuItemSchema), controllers.createItem)
router.get("/:shopId/menu", JWTAuthMiddleware, controllers.getMenuList)
router.get("/:shopId/menu/:itemId", JWTAuthMiddleware, controllers.isOnShopMenu, controllers.getMenuItem)
// The ability guard reads the validated body (the switch alone, or an edit), so it runs after validate.
router.put("/:shopId/menu/:itemId", JWTAuthMiddleware, isShopManager, controllers.isOnShopMenu, validate(editMenuItemSchema), allowsMenuChange, controllers.editItem)
// Every check runs before the upload, so a refused request never reaches Cloudinary.
router.put("/:shopId/menu/:itemId/img", JWTAuthMiddleware, isShopManager, allows("menu.edit"), controllers.isOnShopMenu, menuItemImageUpload, controllers.editItemImage)
router.delete("/:shopId/menu/:itemId", JWTAuthMiddleware, isShopManager, allows("menu.edit"), controllers.deleteItem)

export default router