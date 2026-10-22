import { Router } from "express"
import { shopCoverUpload } from "../../settings/cloudinary"
import { allows, canCreateShops, isShopManager, isShopOwner, JWTAuthMiddleware } from "../auth/middlewares"
import * as shopControllers from "./controllers/shopControllers"
import * as tableControllers from "./controllers/tableControllers"
import * as salesControllers from "./controllers/salesControllers"
import * as staffControllers from "./controllers/staffControllers"
import * as managerControllers from "../carts/managerControllers"
import * as paybackControllers from "../payments/paybackControllers"
import { paybackDoneSchema } from "../payments/paybackControllers"
import { validate } from "../../middlewares/validate"
import { peopleAddedLimit } from "../../middlewares/rateLimits"
import { createShopSchema, editShopSchema, createTableSchema, editTableSchema, browseShopsSchema, salesQuerySchema, salesExportSchema, addStaffSchema, handOverSchema, setMemberRoleSchema } from "./schemas"
import { cartItemSchema, releaseSelectionSchema, refundSchema } from "../carts/schemas"

const router = Router()

// My Shop Routes
router.post("/", JWTAuthMiddleware, canCreateShops, validate(createShopSchema), shopControllers.createShop)
router.get("/", shopControllers.getAllShops)
// Any signed-in account: the shops it is a member of ([] for none; every shop
// for an administrator).
router.get("/me", JWTAuthMiddleware, shopControllers.getMyShops)
// Before "/:shopId", which would otherwise take "browse" as a shop id.
router.get("/browse", validate(browseShopsSchema, "query"), shopControllers.browseShops)
router.get("/:shopId", shopControllers.getSingleShop)
// A member of the shop (isShopManager, whatever their account role) whose role
// holds the route's ability (allows; the table is shops/roles.ts).
router.put("/:shopId", JWTAuthMiddleware, isShopManager, allows("shop.edit"), validate(editShopSchema), shopControllers.editMyShop)
// Both guards run before the upload, so a refused request never reaches Cloudinary.
router.put("/:shopId/cover", JWTAuthMiddleware, isShopManager, allows("shop.edit"), shopCoverUpload, shopControllers.editMyShopCover)
// The owner alone (or an administrator): the shop goes with everything in it.
router.delete("/:shopId", JWTAuthMiddleware, isShopOwner, shopControllers.deleteMyShop)

// The shop's staff (staffControllers.ts): every member sees the list; who may
// add, re-role or remove whom depends on the target's role as well as the
// caller's, so those three decide in the controller (mayHandle) from the
// guard's req.shopRole. Handing the shop over has its own path, so "owner" is
// never taken for a userId.
router.get("/:shopId/staff", JWTAuthMiddleware, isShopManager, allows("staff.read"), staffControllers.listStaff)
router.post("/:shopId/staff", JWTAuthMiddleware, isShopManager, peopleAddedLimit, validate(addStaffSchema), staffControllers.addStaff)
router.put("/:shopId/staff/:userId", JWTAuthMiddleware, isShopManager, validate(setMemberRoleSchema), staffControllers.setMemberRole)
router.delete("/:shopId/staff/:userId", JWTAuthMiddleware, isShopManager, staffControllers.removeStaff)
router.put("/:shopId/owner", JWTAuthMiddleware, isShopOwner, validate(handOverSchema), staffControllers.handOver)

// The shop's sales report, over its orders.
router.get("/:shopId/sales", JWTAuthMiddleware, isShopManager, allows("sales.read"), validate(salesQuerySchema, "query"), salesControllers.getSales)
router.get("/:shopId/sales/export", JWTAuthMiddleware, isShopManager, allows("sales.read"), validate(salesExportSchema, "query"), salesControllers.exportSales)

// Shop's Tables Routes
// Manager views of the tables' carts. `tables/status` is declared before the
// public `tables/:tableId`, which would otherwise take "status" as a table id.
router.get("/:shopId/tables/status", JWTAuthMiddleware, isShopManager, allows("tables.read"), managerControllers.getTablesStatus)
router.get("/:shopId/tables/:tableId/carts", JWTAuthMiddleware, isShopManager, allows("tables.read"), managerControllers.getTableCarts)
// Fixes to a table's open cart (no money moves): the floor's as well as the till's.
router.post("/:shopId/tables/:tableId/carts/:cartId/releaseSelection", JWTAuthMiddleware, isShopManager, allows("carts.fix"), validate(releaseSelectionSchema), managerControllers.releaseSelection)
router.post("/:shopId/tables/:tableId/carts/:cartId/removeItem", JWTAuthMiddleware, isShopManager, allows("carts.fix"), validate(cartItemSchema), managerControllers.removeItem)
router.post("/:shopId/tables/:tableId/carts/:cartId/close", JWTAuthMiddleware, isShopManager, allows("carts.fix"), managerControllers.closeCart)
router.post("/:shopId/tables/:tableId/carts/:cartId/mergeInto", JWTAuthMiddleware, isShopManager, allows("carts.fix"), managerControllers.mergeInto)
// Refunds (money moves), open or closed carts of the shop: the till's.
router.post("/:shopId/carts/:cartId/refunds", JWTAuthMiddleware, isShopManager, allows("payments.manage"), validate(refundSchema), managerControllers.refundItems)
router.post("/:shopId/carts/:cartId/refunds/:refundId/retry", JWTAuthMiddleware, isShopManager, allows("payments.manage"), managerControllers.retryRefund)
// A payment its provider hadn't confirmed at checkout: ask it again.
router.post("/:shopId/carts/:cartId/payments/:paymentId/check", JWTAuthMiddleware, isShopManager, allows("payments.manage"), managerControllers.checkPayment)
// Money Stripe won't give back, which staff pay back another way: marked done.
router.post("/:shopId/paybacks/:paybackId/done", JWTAuthMiddleware, isShopManager, allows("payments.manage"), validate(paybackDoneSchema), paybackControllers.markPaybackDone)
router.post("/:shopId/tables", JWTAuthMiddleware, isShopManager, allows("tables.edit"), validate(createTableSchema), tableControllers.createTable)
router.get("/:shopId/tables", JWTAuthMiddleware, tableControllers.getTableList)
router.get("/:shopId/tables/:tableId",  tableControllers.getSingleTable)
router.put("/:shopId/tables/:tableId", JWTAuthMiddleware, isShopManager, allows("tables.edit"), validate(editTableSchema), tableControllers.editTable)
router.delete("/:shopId/tables/:tableId", JWTAuthMiddleware, isShopManager, allows("tables.edit"), tableControllers.deleteTable)

export default router