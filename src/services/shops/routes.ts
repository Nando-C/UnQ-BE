import { Router } from "express"
import { menuItemImageParser, shopCoverParser } from "../../settings/cloudinary"
import { adminOnly, isShopManager, JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers/shopControllers"
import * as menuControllers from "./controllers/menuControllers"
import * as tableControllers from "./controllers/tableControllers"

const router = Router()

// My Shop Routes
router.post("/", JWTAuthMiddleware, adminOnly, controllers.createShop)
router.get("/", JWTAuthMiddleware, adminOnly, controllers.getMyShops)
router.get("/:shopId", JWTAuthMiddleware, adminOnly, controllers.getMySingleShop)
router.put("/:shopId", JWTAuthMiddleware, adminOnly, controllers.editMyShop)
router.put("/:shopId/cover", JWTAuthMiddleware, adminOnly, shopCoverParser.single("cover"), controllers.editMyShopCover)
router.delete("/:shopId", JWTAuthMiddleware, adminOnly, controllers.deleteMyShop)

// Shop's Menu Routes
router.post("/:shopId/menu", JWTAuthMiddleware, adminOnly, menuControllers.createItem)
router.get("/:shopId/menu", JWTAuthMiddleware, adminOnly, menuControllers.getMenuList)
router.get("/:shopId/menu/:itemId", JWTAuthMiddleware, adminOnly, menuControllers.getMenuItem)
router.put("/:shopId/menu/:itemId", JWTAuthMiddleware, adminOnly, isShopManager, menuControllers.editItem)
router.put("/:shopId/menu/:itemId/img", JWTAuthMiddleware, isShopManager, menuItemImageParser.single("image"), menuControllers.editItemImage)
router.delete("/:shopId/menu/:itemId", JWTAuthMiddleware, adminOnly, isShopManager, menuControllers.deleteItem)

// Shop's Tables Routes
router.post("/:shopId/tables", JWTAuthMiddleware, isShopManager, tableControllers.createTable)
router.get("/:shopId/tables", JWTAuthMiddleware, isShopManager, tableControllers.getTableList)
router.get("/:shopId/tables/:tableId", JWTAuthMiddleware, isShopManager, tableControllers.getSingleTable)
router.put("/:shopId/tables/:tableId", JWTAuthMiddleware, isShopManager, tableControllers.editTable)
router.delete("/:shopId/tables/:tableId", JWTAuthMiddleware, isShopManager, tableControllers.deleteTable)

export default router