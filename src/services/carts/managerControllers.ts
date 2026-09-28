import { TController } from "src/typings/controllers"
import { ICartDocument } from "src/typings/cart"
import CartModel from "./model"
import ShopModel from "../shops/model"
import createError from "http-errors"
import { menuRef, removeUnpaidUnits } from "./controllers"
import UserModel from "../users/model"
import { IUserDocument } from "src/typings/users"

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

// People in the manager view, by first name only: diners in selections and
// payments, and the managers in the log.
const DINER_NAMES = [
    { path: "split.userId", model: "User", select: "name" },
    { path: "payments.userId", model: "User", select: "name" },
    { path: "managerLog.byUserId", model: "User", select: "name" },
]

// toObject, not toJSON: toJSON is the diner view, which strips the payment
// records, the manager log and other diners' notices.
const plain = (cart: ICartDocument) => {
    const obj = cart.toObject()
    delete obj.__v
    return obj
}

// A cart as the manager views it, after an action: menus and names filled in.
const managerView = async (cart: ICartDocument) =>
    plain(await cart.populate([menuRef("items.menuId"), menuRef("split.menuId"), ...DINER_NAMES]))

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
            .populate(DINER_NAMES)

        res.send({
            open: carts.filter((c) => c.status === "open").map(plain),
            recentlyClosed: carts.filter((c) => c.status !== "open").map(plain),
        })
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------
// Fixing a table (no money moves). Each action loads the open cart, changes it
// in memory and saves it version-checked, like the diner's bin (deleteItem): a
// payment settling at the same moment makes one of them fail with 409 rather
// than overwrite the other. Each leaves a note for the diners and a line in the
// manager log. Routes: /shops/:shopId/tables/:tableId/carts/:cartId/<action>.

const CART_CHANGED = "The cart changed, please retry"

type Params = { shopId: string; tableId: string; cartId: string }

// The open cart :cartId of table :tableId in shop :shopId, menus populated (for
// the names in notes), or null.
const loadManagedCart = async ({ shopId, tableId, cartId }: Params) => {
    const onShop = await ShopModel.exists({ _id: shopId, "tables._id": tableId })
    if (!onShop) return null
    return CartModel.findOne({ _id: cartId, tableId, status: "open" })
        .populate(menuRef("items.menuId"))
        .populate(menuRef("split.menuId"))
}

// false on a version conflict.
const saveChecked = async (cart: ICartDocument) => {
    try {
        await cart.save()
        return true
    } catch (error) {
        if ((error as { name?: string }).name === "VersionError") return false
        throw error
    }
}

const idOf = (ref: unknown) => String((ref as { _id?: unknown } | null)?._id ?? ref)
const nameOf = (ref: unknown) => (ref as { name?: string } | null)?.name ?? "item"
const units = (qty: number, menuRef: unknown) => `${qty}× ${nameOf(menuRef)}`

const note = (cart: ICartDocument, message: string, forUserId?: unknown) =>
    cart.notices.push({ at: new Date(), message, ...(forUserId ? { forUserId: forUserId as never } : {}) })

const log = (cart: ICartDocument, req: Parameters<TController>[0], action: string, details: string) =>
    cart.managerLog.push({ at: new Date(), byUserId: (req.user as IUserDocument)._id, action, details })

// Nothing ever paid on this cart: closing it can simply delete it.
const neverPaid = (cart: ICartDocument) =>
    !cart.items.some((i) => i.qtyPayed > 0) &&
    !cart.split.some((s) => s.splitStatus === "closed") &&
    cart.payments.length === 0

// Drops every unpaid unit and open selection, keeping paid units as the record;
// returns what went.
const dropUnpaid = (cart: ICartDocument) => {
    const dropped = cart.items
        .filter((i) => i.qty > i.qtyPayed)
        .map((i) => ({ menuId: idOf(i.menuId), name: nameOf(i.menuId), qty: i.qty - i.qtyPayed }))
    for (const line of cart.items) line.qty = line.qtyPayed
    cart.items = cart.items.filter((i) => i.qty > 0)
    cart.split = cart.split.filter((s) => s.splitStatus !== "open")
    return dropped
}

// POST …/releaseSelection { userId?, menuId? }: frees units held in open
// selections (all of them, one diner's, or one item's) so others can pay. Each
// diner affected gets a note of their own.
export const releaseSelection: TController = async ( req, res, next ) => {
    try {
        const cart = await loadManagedCart(req.params as Params)
        if (!cart) return next(createError(404, "Cart Not Found!"))
        const { userId, menuId } = req.body as { userId?: string; menuId?: string }

        const released = cart.split.filter((s) =>
            s.splitStatus === "open" &&
            (!userId || String(s.userId) === userId) &&
            (!menuId || idOf(s.menuId) === menuId))
        if (released.length === 0) return next(createError(404, "No selection to release"))

        cart.split = cart.split.filter((s) => !released.includes(s))
        const byDiner = new Map<string, string[]>()
        for (const s of released) {
            byDiner.set(String(s.userId), [...(byDiner.get(String(s.userId)) ?? []), units(s.qty, s.menuId)])
        }
        const names = new Map(
            (await UserModel.find({ _id: { $in: [...byDiner.keys()] } }).select("name"))
                .map((u) => [String(u._id), u.name])
        )
        for (const [diner, what] of byDiner) {
            note(cart, `The staff released your selection of ${what.join(", ")}.`, diner)
        }
        log(cart, req, "releaseSelection",
            [...byDiner].map(([diner, what]) => `${names.get(diner) ?? "A diner"}: ${what.join(", ")}`).join("; "))

        if (!(await saveChecked(cart))) return next(createError(409, CART_CHANGED))
        res.send(await managerView(cart))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// POST …/removeItem { menuId }: takes an item's unpaid units out of the cart,
// by the same rule as the diner's bin; paid units stay as the record.
export const removeItem: TController = async ( req, res, next ) => {
    try {
        const cart = await loadManagedCart(req.params as Params)
        if (!cart) return next(createError(404, "Cart Not Found!"))
        const { menuId } = req.body as { menuId: string }

        const line = cart.items.find((i) => idOf(i.menuId) === menuId)
        if (!line) return next(createError(404, "Item Not Found in Cart!"))
        if (line.qty <= line.qtyPayed) return next(createError(409, "Nothing unpaid to remove"))

        const what = units(line.qty - line.qtyPayed, line.menuId)
        removeUnpaidUnits(cart, menuId)
        note(cart, `The staff removed ${what} from this table's cart.`)
        log(cart, req, "removeItem", what)

        if (!(await saveChecked(cart))) return next(createError(409, CART_CHANGED))
        res.send(await managerView(cart))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// POST …/close: ends the table's cart so the next party starts fresh. Unpaid
// units and open selections are dropped (the kitchen only acts on paid
// orders); paid units stay. A cart where nothing was ever paid is deleted.
// Answers { deleted, dropped, cart? } so the manager sees what went.
export const closeCart: TController = async ( req, res, next ) => {
    try {
        const cart = await loadManagedCart(req.params as Params)
        if (!cart) return next(createError(404, "Cart Not Found!"))

        if (neverPaid(cart)) {
            const dropped = dropUnpaid(cart)
            await CartModel.deleteOne({ _id: cart._id })
            return res.send({ deleted: true, dropped })
        }

        const dropped = dropUnpaid(cart)
        cart.status = "closed"
        note(cart, "The staff closed this table.")
        log(cart, req, "close", dropped.length
            ? `dropped ${dropped.map((d) => `${d.qty}× ${d.name}`).join(", ")}`
            : "nothing unpaid")

        if (!(await saveChecked(cart))) return next(createError(409, CART_CHANGED))
        res.send({ deleted: false, dropped, cart: await managerView(cart) })
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// POST …/mergeInto: for a table with more than one open cart (data from before
// the one-open-cart index), moves this older cart's unpaid units and open
// selections into the newest one, which is the one diners see. Its paid units
// stay on it as the record, and it closes (or is deleted, if nothing on it was
// ever paid). Two documents with no transaction: the newest is saved first, so
// a failure in between can at worst leave units in both, never lose them.
export const mergeInto: TController = async ( req, res, next ) => {
    try {
        const source = await loadManagedCart(req.params as Params)
        if (!source) return next(createError(404, "Cart Not Found!"))
        const target = await CartModel.findOne({ tableId: source.tableId, status: "open", _id: { $ne: source._id } })
            .sort({ createdAt: -1 })
        if (!target) return next(createError(409, "This table has only one open cart"))
        const createdAt = (c: ICartDocument) => (c as unknown as { createdAt: Date }).createdAt.getTime()
        if (createdAt(source) > createdAt(target)) {
            return next(createError(409, "Merge the older cart into the newest one"))
        }

        const moved: string[] = []
        for (const line of source.items) {
            const unpaid = line.qty - line.qtyPayed
            if (unpaid <= 0) continue
            const into = target.items.find((i) => idOf(i.menuId) === idOf(line.menuId))
            if (into) into.qty += unpaid
            else target.items.push({ menuId: idOf(line.menuId) as never, qty: unpaid, qtyPayed: 0 })
            moved.push(units(unpaid, line.menuId))
        }
        for (const sel of source.split.filter((s) => s.splitStatus === "open")) {
            const into = target.split.find((s) =>
                s.splitStatus === "open" && String(s.userId) === String(sel.userId) && idOf(s.menuId) === idOf(sel.menuId))
            if (into) into.qty += sel.qty
            else target.split.push({ userId: sel.userId, menuId: idOf(sel.menuId) as never, qty: sel.qty, splitStatus: "open", claimedAt: sel.claimedAt })
        }
        const details = `from cart ${source._id}: ${moved.join(", ") || "nothing unpaid"}`
        log(target, req, "mergeInto", details)
        if (!(await saveChecked(target))) return next(createError(409, CART_CHANGED))

        const removeSource = neverPaid(source)
        dropUnpaid(source)
        if (removeSource) {
            await CartModel.deleteOne({ _id: source._id })
        } else {
            source.status = "closed"
            log(source, req, "mergeInto", `moved to cart ${target._id}: ${moved.join(", ") || "nothing unpaid"}`)
            if (!(await saveChecked(source))) return next(createError(409, CART_CHANGED))
        }
        res.send(await managerView(target))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

