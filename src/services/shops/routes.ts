import { Router } from "express"
import { shopCoverParser } from "../../settings/cloudinary"
import { adminOnly, JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"

const router = Router()

router.post("/me", JWTAuthMiddleware, adminOnly, controllers.createShop)
router.get("/me", JWTAuthMiddleware, adminOnly, controllers.getMyShops)
router.get("/me/:shopId", JWTAuthMiddleware, adminOnly, controllers.getMySingleShop)
router.put("/me/:shopId", JWTAuthMiddleware, adminOnly, controllers.editMyShop)
router.put("/me/:shopId/cover", JWTAuthMiddleware, adminOnly, shopCoverParser.single("cover"), controllers.editMyShopCover)
router.delete("/me/:shopId", JWTAuthMiddleware, adminOnly, controllers.deleteMyShop)

export default router