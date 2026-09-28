import { TController } from "src/typings/controllers"
import { ICartDocument } from "src/typings/cart"
import CartModel from "./model"
import ShopModel from "../shops/model"
import createError from "http-errors"
import { menuRef } from "./controllers"

// A shop manager's view of the tables' carts (read-only). Both routes run after
// isShopManager, so the shop exists and the caller manages it. These are the only
// responses that include payment records (the diner-facing ones strip them).

// A selection held longer than this is flagged for the manager.
const STALE_SELECTION_MS = 15 * 60 * 1000
// Closed carts are listed for this long, since refunds usually come after a
// table has finished.
const RECENTLY_CLOSED_MS = 24 * 60 * 60 * 1000

type Menu = { price?: number; available?: boolean } | null
const menuOf = (ref: unknown) => ref as Menu
const round2 = (n: number) => Math.round(n * 100) / 100

// -------------------------------------------------------------------------

type TableState = "free" | "ordering" | "waitingToPay" | "partlyPaid"
type Attention = "soldOut" | "duplicateCarts" | "staleSelection"

// A table's state from its open carts (newest first; more than one only for
// legacy duplicates). Money as the diner's cart counts it: the unpaid units of a
// sold-out item aren't owed, and a paid unit counts at the price it was paid at
// (current price for payments made before prices were recorded).
const tableSummary = (carts: ICartDocument[], now: number) => {
    let owed = 0
    let paid = 0
    let anyItems = false
    let anyPaid = false
    let heldSince: Date | undefined
    const attention = new Set<Attention>()

    if (carts.length > 1) attention.add("duplicateCarts")

    for (const cart of carts) {
        for (const item of cart.items) {
            anyItems = true
            const menu = menuOf(item.menuId)
            const unpaid = item.qty - (item.qtyPayed ?? 0)
            if (item.qtyPayed > 0) anyPaid = true
            if (menu?.available === false) {
                if (unpaid > 0) attention.add("soldOut")
            } else {
                owed += unpaid * (menu?.price ?? 0)
            }
        }
        for (const split of cart.split) {
            if (split.splitStatus === "closed") {
                paid += split.qty * (split.unitPrice ?? menuOf(split.menuId)?.price ?? 0)
            } else if (split.claimedAt) {
                if (!heldSince || split.claimedAt < heldSince) heldSince = split.claimedAt
                if (now - split.claimedAt.getTime() > STALE_SELECTION_MS) attention.add("staleSelection")
            }
        }
    }

    const selecting = carts.some((c) => c.split.some((s) => s.splitStatus === "open"))
    const state: TableState = !anyItems && !selecting
        ? "free"
        : selecting
            ? "waitingToPay"
            : anyPaid
                ? "partlyPaid"
                : "ordering"

    return { state, owed: round2(owed), paid: round2(paid), heldSince, attention: [...attention] }
}

// GET /shops/:shopId/tables/status — one entry per table of the shop.
export const getTablesStatus: TController = async ( req, res, next ) => {
    try {
        const shop = await ShopModel.findById(req.params.shopId).select("tables")
        if (!shop) return next(createError(404, "Shop Not Found!"))

        const tableIds = shop.tables.map((t) => String(t._id))
        const openCarts = await CartModel.find({ tableId: { $in: tableIds }, status: "open" })
            .sort({ createdAt: -1 })
            .populate(menuRef("items.menuId"))
            .populate(menuRef("split.menuId"))

        const now = Date.now()
        res.send(shop.tables.map((table) => {
            const tableId = String(table._id)
            return {
                tableId,
                name: table.name,
                ...tableSummary(openCarts.filter((c) => c.tableId === tableId), now),
            }
        }))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

// GET /shops/:shopId/tables/:tableId/carts — the table's open cart(s) and those
// closed in the last 24 hours, newest first, with payment records. Diners (in
// selections and payments) are shown by first name only, never their email.
export const getTableCarts: TController = async ( req, res, next ) => {
    try {
        const { shopId, tableId } = req.params
        const onShop = await ShopModel.exists({ _id: shopId, "tables._id": tableId })
        if (!onShop) return next(createError(404, "Table Not Found!"))

        const since = new Date(Date.now() - RECENTLY_CLOSED_MS)
        const carts = await CartModel.find({
            tableId,
            $or: [{ status: "open" }, { status: "closed", updatedAt: { $gte: since } }],
        })
            .sort({ createdAt: -1 })
            .populate(menuRef("items.menuId"))
            .populate(menuRef("split.menuId"))
            .populate({ path: "split.userId", model: "User", select: "name" })
            .populate({ path: "payments.userId", model: "User", select: "name" })

        // toObject, not toJSON: toJSON strips the payment records.
        const view = (cart: ICartDocument) => {
            const obj = cart.toObject()
            delete obj.__v
            return obj
        }
        res.send({
            open: carts.filter((c) => c.status === "open").map(view),
            recentlyClosed: carts.filter((c) => c.status !== "open").map(view),
        })
    } catch (error) {
        next(createError(500, error as Error))
    }
}
