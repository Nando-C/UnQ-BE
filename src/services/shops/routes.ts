import { Router } from "express"
import { shopCoverParser } from "../../settings/cloudinary"
import { adminOnly, isShopManager, JWTAuthMiddleware } from "../auth/middlewares"
import * as shopControllers from "./controllers/shopControllers"
import * as tableControllers from "./controllers/tableControllers"
import { validate } from "../../middlewares/validate"
import { createShopSchema, editShopSchema, createTableSchema, editTableSchema } from "./schemas"

const router = Router()

// My Shop Routes
router.post("/", JWTAuthMiddleware, adminOnly, validate(createShopSchema), shopControllers.createShop)
router.get("/", shopControllers.getAllShops)
router.get("/me", JWTAuthMiddleware, adminOnly, shopControllers.getMyShops)
router.get("/:shopId", shopControllers.getSingleShop)
router.put("/:shopId", JWTAuthMiddleware, adminOnly, validate(editShopSchema), shopControllers.editMyShop)
router.put("/:shopId/cover", JWTAuthMiddleware, adminOnly, shopCoverParser.single("cover"), shopControllers.editMyShopCover)
router.delete("/:shopId", JWTAuthMiddleware, adminOnly, shopControllers.deleteMyShop)

// Shop's Tables Routes
router.post("/:shopId/tables", JWTAuthMiddleware, isShopManager, validate(createTableSchema), tableControllers.createTable)
router.get("/:shopId/tables", JWTAuthMiddleware, tableControllers.getTableList)
router.get("/:shopId/tables/:tableId",  tableControllers.getSingleTable)
router.put("/:shopId/tables/:tableId", JWTAuthMiddleware, isShopManager, validate(editTableSchema), tableControllers.editTable)
router.delete("/:shopId/tables/:tableId", JWTAuthMiddleware, isShopManager, tableControllers.deleteTable)

export default router