import { Router } from "express"
import { shopCoverUpload } from "../../settings/cloudinary"
import { adminOnly, isShopManager, JWTAuthMiddleware } from "../auth/middlewares"
import * as shopControllers from "./controllers/shopControllers"
import * as tableControllers from "./controllers/tableControllers"
import * as salesControllers from "./controllers/salesControllers"
import * as managerControllers from "../carts/managerControllers"
import * as paybackControllers from "../payments/paybackControllers"
import { paybackDoneSchema } from "../payments/paybackControllers"
import { validate } from "../../middlewares/validate"
import { createShopSchema, editShopSchema, createTableSchema, editTableSchema, browseShopsSchema, salesQuerySchema, salesExportSchema } from "./schemas"
import { cartItemSchema, releaseSelectionSchema, refundSchema } from "../carts/schemas"

const router = Router()

// My Shop Routes
router.post("/", JWTAuthMiddleware, adminOnly, validate(createShopSchema), shopControllers.createShop)
router.get("/", shopControllers.getAllShops)
router.get("/me", JWTAuthMiddleware, adminOnly, shopControllers.getMyShops)
// Before "/:shopId", which would otherwise take "browse" as a shop id.
router.get("/browse", validate(browseShopsSchema, "query"), shopControllers.browseShops)
router.get("/:shopId", shopControllers.getSingleShop)
router.put("/:shopId", JWTAuthMiddleware, adminOnly, validate(editShopSchema), shopControllers.editMyShop)
// isShopManager (manages THIS shop) runs before the upload, so a refused
// request never reaches Cloudinary.
router.put("/:shopId/cover", JWTAuthMiddleware, isShopManager, shopCoverUpload, shopControllers.editMyShopCover)
router.delete("/:shopId", JWTAuthMiddleware, adminOnly, shopControllers.deleteMyShop)

// The shop's sales report, over its orders.
router.get("/:shopId/sales", JWTAuthMiddleware, isShopManager, validate(salesQuerySchema, "query"), salesControllers.getSales)
router.get("/:shopId/sales/export", JWTAuthMiddleware, isShopManager, validate(salesExportSchema, "query"), salesControllers.exportSales)

// Shop's Tables Routes
// Manager views of the tables' carts. `tables/status` is declared before the
// public `tables/:tableId`, which would otherwise take "status" as a table id.
router.get("/:shopId/tables/status", JWTAuthMiddleware, isShopManager, managerControllers.getTablesStatus)
router.get("/:shopId/tables/:tableId/carts", JWTAuthMiddleware, isShopManager, managerControllers.getTableCarts)
// Manager fixes to a table's open cart (no money moves).
router.post("/:shopId/tables/:tableId/carts/:cartId/releaseSelection", JWTAuthMiddleware, isShopManager, validate(releaseSelectionSchema), managerControllers.releaseSelection)
router.post("/:shopId/tables/:tableId/carts/:cartId/removeItem", JWTAuthMiddleware, isShopManager, validate(cartItemSchema), managerControllers.removeItem)
router.post("/:shopId/tables/:tableId/carts/:cartId/close", JWTAuthMiddleware, isShopManager, managerControllers.closeCart)
router.post("/:shopId/tables/:tableId/carts/:cartId/mergeInto", JWTAuthMiddleware, isShopManager, managerControllers.mergeInto)
// Manager refunds (money moves): open or closed carts of the shop.
router.post("/:shopId/carts/:cartId/refunds", JWTAuthMiddleware, isShopManager, validate(refundSchema), managerControllers.refundItems)
router.post("/:shopId/carts/:cartId/refunds/:refundId/retry", JWTAuthMiddleware, isShopManager, managerControllers.retryRefund)
// A payment its provider hadn't confirmed at checkout: ask it again.
router.post("/:shopId/carts/:cartId/payments/:paymentId/check", JWTAuthMiddleware, isShopManager, managerControllers.checkPayment)
// Money Stripe won't give back, which staff pay back another way: marked done.
router.post("/:shopId/paybacks/:paybackId/done", JWTAuthMiddleware, isShopManager, validate(paybackDoneSchema), paybackControllers.markPaybackDone)
router.post("/:shopId/tables", JWTAuthMiddleware, isShopManager, validate(createTableSchema), tableControllers.createTable)
router.get("/:shopId/tables", JWTAuthMiddleware, tableControllers.getTableList)
router.get("/:shopId/tables/:tableId",  tableControllers.getSingleTable)
router.put("/:shopId/tables/:tableId", JWTAuthMiddleware, isShopManager, validate(editTableSchema), tableControllers.editTable)
router.delete("/:shopId/tables/:tableId", JWTAuthMiddleware, isShopManager, tableControllers.deleteTable)

export default router