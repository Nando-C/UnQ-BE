import { Router } from "express"
import { shopCoverParser } from "../../settings/cloudinary"
import { adminOnly, isShopManager, JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"
import * as menuControllers from "./menuControllers"

const router = Router()

// My Shop Routes
router.post("/", JWTAuthMiddleware, adminOnly, controllers.createShop)
router.get("/", JWTAuthMiddleware, adminOnly, controllers.getMyShops)
router.get("/:shopId", JWTAuthMiddleware, adminOnly, controllers.getMySingleShop)
router.put("/:shopId", JWTAuthMiddleware, adminOnly, controllers.editMyShop)
router.put("/:shopId/cover", JWTAuthMiddleware, adminOnly, shopCoverParser.single("cover"), controllers.editMyShopCover)
router.delete("/:shopId", JWTAuthMiddleware, adminOnly, controllers.deleteMyShop)

// My Shop's Menu Routes
router.post("/:shopId/menu", JWTAuthMiddleware, adminOnly, menuControllers.createItem)
router.get("/:shopId/menu", JWTAuthMiddleware, adminOnly, menuControllers.getMenuList)
router.get("/:shopId/menu/:itemId", JWTAuthMiddleware, adminOnly, menuControllers.getMenuItem)
router.put("/:shopId/menu/:itemId", JWTAuthMiddleware, adminOnly, isShopManager, menuControllers.editMenuItem)
router.delete("/:shopId/menu/:itemId", JWTAuthMiddleware, adminOnly, isShopManager, menuControllers.deleteMenuItem)

export default router