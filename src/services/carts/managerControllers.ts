import { TController } from "src/typings/controllers"
import { ICartDocument } from "src/typings/cart"
import CartModel from "./model"
import ShopModel from "../shops/model"
import createError from "http-errors"
import { menuRef, removeUnpaidUnits } from "./controllers"
import UserModel from "../users/model"
import { providerName, refundPayment } from "../../lib/payments"
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


// -------------------------------------------------------------------------
// Cancel and refund (money moves). POST /shops/:shopId/carts/:cartId/refunds
// { paymentId, lines: [{ menuId, qty }] }: refunds those units of one recorded
// payment, at the prices that payment charged, and takes them out of the cart
// (user decision: refunded units are cancelled, not made payable again). Works
// on open and closed carts of the shop.
//
// Money and records must never disagree, so, in this order:
// (a) a `pending` refund record is saved, version-checked. Pending units count
//     as refunded, so a double click or two managers can't refund them twice.
// (b) the provider is asked, with the record's id as its idempotency key.
// (c) success: the record is completed and the cart updated (retrying on a
//     version conflict); failure: the record says `failed`, nothing else moves.
// If (c) can't be saved, the record stays `pending` and the manager is told to
// check the provider: it's never guessed.

type RefundLine = { menuId: string; qty: number }

const money = (amount: number, currency: string) =>
    new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount)

// Reloads the cart and applies `change` to it, saving version-checked, a few
// times if other writes keep landing. False if it never saved.
const withFreshCart = async (cartId: unknown, change: (cart: ICartDocument) => void) => {
    for (let attempt = 0; attempt < 3; attempt++) {
        const cart = await CartModel.findById(cartId)
        if (!cart) return false
        change(cart)
        if (await saveChecked(cart)) return true
    }
    return false
}

const findById = <T extends { _id?: unknown }>(list: T[], id: unknown) =>
    list.find((x) => String(x._id) === String(id))

// (c) on success: the refund completed, the payment's lines marked, the units
// gone from the cart (item and the payer's paid selection alike), and a note
// for the payer.
const completeRefund = (
    cart: ICartDocument,
    refundId: unknown,
    providerRefundId: string | undefined,
    req: Parameters<TController>[0]
) => {
    const refund = findById(cart.refunds, refundId)
    if (!refund || refund.status !== "pending") return
    const payment = findById(cart.payments, refund.paymentId)
    refund.status = "completed"
    refund.providerRefundId = providerRefundId

    for (const line of refund.lines) {
        const menuId = String(line.menuId)
        const paid = payment?.lines.find((l) => String(l.menuId) === menuId)
        if (paid) paid.refundedQty += line.qty

        const item = cart.items.find((i) => String(i.menuId) === menuId)
        if (item) {
            item.qty -= line.qty
            item.qtyPayed = Math.max(0, item.qtyPayed - line.qty)
        }
        // The payer's paid selections of it: this payment's first (same paidAt).
        let left = line.qty
        const paidSplits = cart.split
            .filter((s) => s.splitStatus === "closed" && String(s.menuId) === menuId && String(s.userId) === String(payment?.userId))
            .sort((a, b) => Number(b.paidAt?.getTime() === payment?.paidAt.getTime()) - Number(a.paidAt?.getTime() === payment?.paidAt.getTime()))
        for (const s of paidSplits) {
            const take = Math.min(left, s.qty)
            s.qty -= take
            left -= take
        }
    }
    cart.items = cart.items.filter((i) => i.qty > 0)
    cart.split = cart.split.filter((s) => s.qty > 0)

    const what = refund.lines.map((l) => `${l.qty}× ${l.name}`).join(", ")
    note(cart, `The staff refunded ${money(refund.amount, refund.currency)} for ${what}.`, payment?.userId)
    log(cart, req, "refund", `${money(refund.amount, refund.currency)} for ${what} (payment ${refund.paymentId})`)
}

export const refundItems: TController = async ( req, res, next ) => {
    try {
        const { shopId, cartId } = req.params
        const { paymentId, lines } = req.body as { paymentId: string; lines: RefundLine[] }
        const user = req.user as IUserDocument

        const cart = await CartModel.findById(cartId)
        const shop = await ShopModel.findById(shopId).select("tables")
        if (!cart || !shop?.tables.some((t) => String(t._id) === cart.tableId)) {
            return next(createError(404, "Cart Not Found!"))
        }
        const payment = findById(cart.payments, paymentId)
        if (!payment) return next(createError(404, "Payment Not Found!"))
        if (!payment.providerPaymentId) {
            return next(createError(409, `This payment can only be refunded from ${providerName(payment)}`))
        }

        // What's left to refund of each line: paid, less refunded, less refunds
        // already under way.
        const underWay = (menuId: string) => cart.refunds
            .filter((r) => r.status === "pending" && String(r.paymentId) === paymentId)
            .flatMap((r) => r.lines)
            .filter((l) => String(l.menuId) === menuId)
            .reduce((sum, l) => sum + l.qty, 0)
        const refundLines = []
        for (const { menuId, qty } of lines) {
            const paid = payment.lines.find((l) => String(l.menuId) === menuId)
            if (!paid) return next(createError(400, "That item isn't in this payment"))
            const left = paid.qty - paid.refundedQty - underWay(menuId)
            if (qty > left) {
                return next(createError(400, left > 0
                    ? `Only ${left}× ${paid.name} of this payment can still be refunded`
                    : `${paid.name} from this payment has already been refunded`))
            }
            refundLines.push({ menuId: paid.menuId, name: paid.name, qty, unitPrice: paid.unitPrice })
        }
        const amount = Math.round(refundLines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0) * 100) / 100

        // (a)
        cart.refunds.push({
            paymentId: payment._id as never,
            lines: refundLines.map(({ menuId, name, qty }) => ({ menuId, name, qty })),
            amount,
            currency: payment.currency,
            status: "pending",
            byUserId: user._id,
            at: new Date(),
        })
        const refundId = cart.refunds[cart.refunds.length - 1]._id
        if (!(await saveChecked(cart))) return next(createError(409, CART_CHANGED))

        // (b)
        let providerRefundId: string | undefined
        try {
            ({ providerRefundId } = await refundPayment(payment, amount, String(refundId)))
        } catch (error) {
            const reason = (error as Error).message
            const recorded = await withFreshCart(cartId, (c) => {
                const r = findById(c.refunds, refundId)
                if (r?.status === "pending") {
                    r.status = "failed"
                    r.failureReason = reason
                }
            })
            if (!recorded) console.error("Refund failed and couldn't be marked failed", { cartId, refundId, reason })
            return next(createError(502, `${reason}. Nothing was refunded.`, { expose: true }))
        }

        // (c)
        const completed = await withFreshCart(cartId, (c) => completeRefund(c, refundId, providerRefundId, req))
        if (!completed) {
            console.error("Refund went through but couldn't be recorded", { cartId, refundId, providerRefundId })
            return next(createError(500,
                `The refund went through at ${providerName(payment)} but couldn't be recorded here. It shows as in progress: check ${providerName(payment)} before refunding again.`,
                { expose: true }))
        }

        const fresh = await CartModel.findById(cartId).populate(menuRef("items.menuId")).populate(menuRef("split.menuId"))
        res.send({ refund: findById(fresh!.refunds, refundId), cart: await managerView(fresh!) })
    } catch (error) {
        next(createError(500, error as Error))
    }
}
