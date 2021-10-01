import { Router } from "express"
import { menuItemImageParser } from "../../settings/cloudinary"
import { isShopManager, JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"

const router = Router()

router.post("/:shopId/menu", JWTAuthMiddleware, isShopManager, controllers.createItem)
router.get("/:shopId/menu", JWTAuthMiddleware, isShopManager, controllers.getMenuList)
router.get("/:shopId/menu/:itemId", JWTAuthMiddleware, isShopManager, controllers.getMenuItem)
router.put("/:shopId/menu/:itemId", JWTAuthMiddleware, isShopManager, controllers.editItem)
router.put("/:shopId/menu/:itemId/img", JWTAuthMiddleware, isShopManager, menuItemImageParser.single("image"), controllers.editItemImage)
router.delete("/:shopId/menu/:itemId", JWTAuthMiddleware, isShopManager, controllers.deleteItem)

export default router