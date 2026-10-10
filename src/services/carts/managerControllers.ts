import mongoose from "mongoose"
import { TController } from "src/typings/controllers"
import { ICartDocument, IPayment, PaymentStatus, RefundReason } from "src/typings/cart"
import CartModel, { AWAITING_PROVIDER, RECENTLY_CLOSED_MS, refId, tookPart } from "./model"
import { hasCheckoutRecord, isDisputeReason, syncRecordFromCart } from "./stripeCheckout"
import ShopModel, { ofTable, shopIdOfCart } from "../shops/model"
import { keepOrderInStep } from "../orders/sync"
import createError from "http-errors"
import { CART_MENUS, closeIfPaidOff, hasPendingPayment, loadOpenCart, removeUnpaidUnits } from "./controllers"
import { saveChecked } from "../../lib/mongo"
import PaybackModel, { tablePaybacks, writePayback } from "../payments/payback"
import { fromPence, money, toPence } from "../../lib/money"
import UserModel from "../users/model"
import { awaitedProvider, checkProviderPayment, findProviderRefund, providerName, refundPayment, RefundRefused } from "../../lib/payments"
import { IUserDocument } from "src/typings/users"

// The shop manager's side of the tables' carts: viewing them, fixing them
// (no money moves), and refunds and payment checks (money moves). Every route
// runs after isShopManager, so the shop exists and the caller manages it. These
// are the only responses that include payment records (the diner-facing ones
// strip them).

// A selection held longer than this is flagged for the manager.
const STALE_SELECTION_MS = 15 * 60 * 1000


type Menu = { price?: number; available?: boolean } | null
const menuOf = (ref: unknown) => ref as Menu
// To the penny, as money.ts rounds.
const round2 = (n: number) => fromPence(toPence(n))

// -------------------------------------------------------------------------

// Views (read-only).

// free: nothing ordered; ordering: items, none paid or selected; waitingToPay:
// someone has a selection open; partlyPaid: some units paid, none selected
// now.
type TableState = "free" | "ordering" | "waitingToPay" | "partlyPaid"
type Attention = "soldOut" | "duplicateCarts" | "staleSelection" | "paymentPending" | "payBack"

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
    if (carts.some(hasPendingPayment)) attention.add("paymentPending")

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
    const state: TableState = selecting ? "waitingToPay" : !anyItems ? "free" : anyPaid ? "partlyPaid" : "ordering"

    return { state, owed: round2(owed), paid: round2(paid), heldSince, attention: [...attention] }
}

// GET /shops/:shopId/tables/status — one entry per table of the shop.
export const getTablesStatus: TController = async ( req, res, next ) => {
    try {
        const shop = await ShopModel.findById(req.params.shopId).select("tables")
        if (!shop) return next(createError(404, "Shop Not Found!"))

        const tableIds = shop.tables.map((t) => String(t._id))
        const [openCarts, owedAt] = await Promise.all([
            CartModel.find({ tableId: { $in: tableIds }, status: "open" })
                .sort({ createdAt: -1 })
                .populate(CART_MENUS),
            // A diner still to be paid back there (S35), whatever its carts.
            PaybackModel.distinct("tableId", { shopId: shop._id, owed: true }),
        ])
        const owed = new Set(owedAt)

        const now = Date.now()
        res.send(shop.tables.map((table) => {
            const tableId = String(table._id)
            const summary = tableSummary(openCarts.filter((c) => c.tableId === tableId), now)
            if (owed.has(tableId)) summary.attention.push("payBack")
            return { tableId, name: table.name, ...summary }
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
    plain(await cart.populate([...CART_MENUS, ...DINER_NAMES]))

// GET /shops/:shopId/tables/:tableId/carts — the table's open cart(s) and those
// closed in the last 24 hours, newest first, with payment records. Diners (in
// selections and payments) are shown by first name only, never their email.
// A deleted table's too, so its last carts can still be refunded. An older
// closed cart is included while its provider still owes it an answer, to be
// checked.
export const getTableCarts: TController = async ( req, res, next ) => {
    try {
        const { shopId, tableId } = req.params
        const onShop = await ShopModel.exists({ _id: shopId, ...ofTable(tableId) })
        if (!onShop) return next(createError(404, "Table Not Found!"))

        const since = new Date(Date.now() - RECENTLY_CLOSED_MS)
        const [carts, paybacks] = await Promise.all([
            CartModel.find({
                tableId,
                $or: [
                    { status: "open" },
                    { status: "closed", updatedAt: { $gte: since } },
                    { status: "closed", ...AWAITING_PROVIDER },
                ],
            })
                .sort({ createdAt: -1 })
                .populate(CART_MENUS)
                .populate(DINER_NAMES),
            // Owed, and done in the last 30 days (S35): the table's, whichever
            // cart they came from (it may be gone).
            tablePaybacks(tableId),
        ])

        res.send({
            open: carts.filter((c) => c.status === "open").map(plain),
            recentlyClosed: carts.filter((c) => c.status !== "open").map(plain),
            paybacks,
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
// Closing or merging would take a pending payment's units off the open table
// before anyone knows whether they were paid.
const paymentPending = (cart: ICartDocument) => `A payment on this table is still awaiting ${awaitedProvider(cart)}: check it first`

type Params = { shopId: string; tableId: string; cartId: string }

// The open cart :cartId of table :tableId in shop :shopId, menus populated (for
// the names in notes), or null. A deleted table's too: an order that landed as
// it was deleted leaves one there, to be closed.
const loadManagedCart = async ({ shopId, tableId, cartId }: Params) => {
    const onShop = await ShopModel.exists({ _id: shopId, ...ofTable(tableId) })
    if (!onShop) return null
    return loadOpenCart(cartId, tableId)
}

// Deletes a cart that neverPaid() said could go, only if it's unchanged since it
// was loaded and still has no payment: a diner's payment settling in between
// must never be deleted with it. False when it wasn't deleted.
const deleteIfUnchanged = async (cart: ICartDocument) =>
    (await CartModel.deleteOne({ _id: cart._id, __v: cart.get("__v"), "payments.0": { $exists: false } })).deletedCount === 1

const nameOf = (ref: unknown) => (ref as { name?: string } | null)?.name ?? "item"
const units = (qty: number, menuRef: unknown) => `${qty}× ${nameOf(menuRef)}`

const note = (cart: ICartDocument, message: string, forUserId?: unknown) =>
    cart.notices.push({ at: new Date(), message, ...(forUserId ? { forUserId: forUserId as never } : {}) })

// The diners with an open selection, before an action drops them.
const openSelectors = (cart: ICartDocument) =>
    [...new Set(cart.split.filter((s) => s.splitStatus === "open").map((s) => String(s.userId)))]

// Once a cart is closed, its table-wide notices reach only the diners who took
// part in it (tookPart). One whose only part was a selection the action just
// dropped would miss them, so they get the note addressed to them.
const noteDroppedSelectors = (cart: ICartDocument, selectors: string[], message: string) => {
    for (const id of selectors) if (!tookPart(cart, id)) note(cart, message, id)
}

// A line in the cart's manager log, by `actor` (a manager's user id), or by
// the server itself when there's none (the Stripe sweep or webhook).
export const logEntry = (actor: unknown, action: string, details: string) =>
    ({ at: new Date(), ...(actor ? { byUserId: actor as never } : {}), action, details })
export const log = (cart: ICartDocument, actor: unknown, action: string, details: string) =>
    cart.managerLog.push(logEntry(actor, action, details))
// A line by the server on cart `cartId`, once however often it's asked for
// (Stripe repeats events; a refund may be retried). A push moves the cart's
// version (Mongoose), so a save from an older copy retries rather than
// dropping it.
export const logOnce = (cartId: string | mongoose.Types.ObjectId, action: string, details: string) =>
    CartModel.updateOne({ _id: cartId, "managerLog.details": { $ne: details } }, { $push: { managerLog: logEntry(undefined, action, details) } })

// The manager making the request.
const managerOf = (req: Parameters<TController>[0]) => (req.user as IUserDocument)._id

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
        .map((i) => ({ menuId: refId(i.menuId), name: nameOf(i.menuId), qty: i.qty - i.qtyPayed }))
    for (const line of cart.items) line.qty = line.qtyPayed
    cart.items = cart.items.filter((i) => i.qty > 0)
    cart.split = cart.split.filter((s) => s.splitStatus !== "open")
    return dropped
}

// POST …/releaseSelection { userId?, menuId? }: frees units held in open
// selections (all of them, one diner's, or one item's) so others can pay. Each
// diner affected gets a note of their own. userId null means the diners whose
// account no longer exists (the manager sees them as "A diner"): leaving it
// out would release everyone's.
export const releaseSelection: TController = async ( req, res, next ) => {
    try {
        const cart = await loadManagedCart(req.params as Params)
        if (!cart) return next(createError(404, "Cart Not Found!"))
        const { userId, menuId } = req.body as { userId?: string | null; menuId?: string }

        // The names of the diners with a selection, for the log; one missing
        // from it has no account any more.
        const names = new Map(
            (await UserModel.find({ _id: { $in: cart.split.map((s) => s.userId) } }).select("name"))
                .map((u) => [String(u._id), u.name])
        )
        const existing = userId === null ? names : null
        const released = cart.split.filter((s) =>
            s.splitStatus === "open" &&
            (userId === undefined || (existing ? !existing.has(String(s.userId)) : String(s.userId) === userId)) &&
            (!menuId || refId(s.menuId) === menuId))
        if (released.length === 0) return next(createError(404, "No selection to release"))

        cart.split = cart.split.filter((s) => !released.includes(s))
        const byDiner = new Map<string, string[]>()
        for (const s of released) {
            byDiner.set(String(s.userId), [...(byDiner.get(String(s.userId)) ?? []), units(s.qty, s.menuId)])
        }
        for (const [diner, what] of byDiner) {
            note(cart, `The staff released your selection of ${what.join(", ")}.`, diner)
        }
        log(cart, managerOf(req), "releaseSelection",
            [...byDiner].map(([diner, what]) => `${names.get(diner) ?? "A diner"}: ${what.join(", ")}`).join("; "))

        if (!(await saveChecked(cart))) return next(createError(409, CART_CHANGED))
        res.send(await managerView(cart))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// POST …/removeItem { menuId }: takes all of an item's unpaid units out of the
// cart, diners' selections of it included (the diner's bin leaves others'
// selections); paid units stay as the record. A cart left with nothing ordered
// and nothing paid closes, so the table is free again.
export const removeItem: TController = async ( req, res, next ) => {
    try {
        const cart = await loadManagedCart(req.params as Params)
        if (!cart) return next(createError(404, "Cart Not Found!"))
        const { menuId } = req.body as { menuId: string }

        const line = cart.items.find((i) => refId(i.menuId) === menuId)
        if (!line) return next(createError(404, "Item Not Found in Cart!"))
        if (line.qty <= line.qtyPayed) return next(createError(409, "Nothing unpaid to remove"))

        const what = units(line.qty - line.qtyPayed, line.menuId)
        const selectors = openSelectors(cart)
        removeUnpaidUnits(cart, menuId)
        const message = `The staff removed ${what} from this table's cart.`
        note(cart, message)
        if (cart.status === "closed") noteDroppedSelectors(cart, selectors, message)
        log(cart, managerOf(req), "removeItem", what)

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
        if (hasPendingPayment(cart)) return next(createError(409, paymentPending(cart)))

        if (neverPaid(cart)) {
            const dropped = dropUnpaid(cart)
            if (!(await deleteIfUnchanged(cart))) return next(createError(409, CART_CHANGED))
            return res.send({ deleted: true, dropped })
        }

        const selectors = openSelectors(cart)
        const dropped = dropUnpaid(cart)
        cart.status = "closed"
        note(cart, "The staff closed this table.")
        noteDroppedSelectors(cart, selectors, "The staff closed this table.")
        log(cart, managerOf(req), "close", dropped.length
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
// a failure in between (or the older cart changing meanwhile) can at worst
// leave units in both, never lose them or a payment.
export const mergeInto: TController = async ( req, res, next ) => {
    try {
        const source = await loadManagedCart(req.params as Params)
        if (!source) return next(createError(404, "Cart Not Found!"))
        if (hasPendingPayment(source)) return next(createError(409, paymentPending(source)))
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
            const into = target.items.find((i) => refId(i.menuId) === refId(line.menuId))
            if (into) into.qty += unpaid
            else target.items.push({ menuId: refId(line.menuId) as never, qty: unpaid, qtyPayed: 0 })
            moved.push(units(unpaid, line.menuId))
        }
        for (const sel of source.split.filter((s) => s.splitStatus === "open")) {
            const into = target.split.find((s) =>
                s.splitStatus === "open" && String(s.userId) === String(sel.userId) && refId(s.menuId) === refId(sel.menuId))
            if (into) into.qty += sel.qty
            else target.split.push({ userId: sel.userId, menuId: refId(sel.menuId) as never, qty: sel.qty, splitStatus: "open", claimedAt: sel.claimedAt })
        }
        const details = `from cart ${source._id}: ${moved.join(", ") || "nothing unpaid"}`
        log(target, managerOf(req), "mergeInto", details)
        if (!(await saveChecked(target))) return next(createError(409, CART_CHANGED))

        const removeSource = neverPaid(source)
        dropUnpaid(source)
        if (removeSource) {
            // Changed since it was loaded (a payment may have settled on it):
            // kept, and its units are then in both carts, as documented above.
            if (!(await deleteIfUnchanged(source))) return next(createError(409, CART_CHANGED))
        } else {
            source.status = "closed"
            log(source, managerOf(req), "mergeInto", `moved to cart ${target._id}: ${moved.join(", ") || "nothing unpaid"}`)
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
// (refunded units are cancelled, not made payable again). Works
// on open and closed carts of the shop.
//
// Money and records must never disagree, so, in this order:
// (a) a `pending` refund record is saved, version-checked. Pending units count
//     as refunded, so a double click or two managers can't refund them twice.
// (b) the provider is asked, with the record's id as its idempotency key.
// (c) success: the record is completed and the cart updated (retrying on a
//     version conflict); failure: the record says `failed`, nothing else moves.
// If the provider's answer is unclear, or (c) can't be saved, the record stays
// `pending`: it's never guessed. retryRefund settles it later.

type RefundLine = { menuId: string; qty: number }

// Reloads the cart and applies `change` to it, saving version-checked, a few
// times if other writes keep landing. The saved cart, or null if it never saved.
const withFreshCart = async (cartId: unknown, change: (cart: ICartDocument) => void) => {
    for (let attempt = 0; attempt < 3; attempt++) {
        const cart = await CartModel.findById(cartId)
        if (!cart) return null
        change(cart)
        if (await saveChecked(cart)) return cart
    }
    return null
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
    actor: unknown
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
    log(cart, actor, "refund", `${money(refund.amount, refund.currency)} for ${what} (payment ${refund.paymentId})`)
}

// A cart of the shop, open or closed. By the shop the cart records, so its
// payments stay reachable after its table is deleted; older carts without one
// by their table.
const loadShopCart = async (shopId: string, cartId: string) => {
    const cart = await CartModel.findById(cartId)
    if (!cart) return null
    if (cart.shopId) return String(cart.shopId) === shopId ? cart : null
    return (await ShopModel.exists({ _id: shopId, ...ofTable(cart.tableId) })) ? cart : null
}

type Req = Parameters<TController>[0]
type Res = Parameters<TController>[1]
type Next = Parameters<TController>[2]

// Each outcome below syncs the payment's order once the provider has answered
// (syncing before would only delay the refund; if the process stops in
// between, the pending refund is on the cart for a retry or the repair
// script). From the cart as saved with the outcome, else the one in hand,
// saved with the refund pending: what the order then shows. An older cart
// never overwrites a newer order, so no re-read is needed.

// Marks the pending refund failed: the provider refused it, nothing moved.
const markFailed = async (cart: ICartDocument, payment: IPayment, refundId: unknown, reason: string) => {
    const recorded = await withFreshCart(cart._id, (c) => {
        const r = findById(c.refunds, refundId)
        if (r?.status === "pending") {
            r.status = "failed"
            r.failureReason = reason
        }
    })
    if (!recorded) console.error("Refund failed and couldn't be marked failed", { cartId: cart._id, refundId, reason })
    await keepOrderInStep(recorded ?? cart, payment._id)
}

// (c): the provider refunded; complete the record and answer { refund, cart }.
const recordRefund = async (
    req: Req, res: Res, next: Next,
    cart: ICartDocument, payment: IPayment, refundId: unknown, providerRefundId: string | undefined
) => {
    const recorded = await withFreshCart(cart._id, (c) => completeRefund(c, refundId, providerRefundId, managerOf(req)))
    if (!recorded) console.error("Refund went through but couldn't be recorded", { cartId: cart._id, refundId, providerRefundId })
    await keepOrderInStep(recorded ?? cart, payment._id)
    if (!recorded) {
        return next(createError(500,
            `The refund went through at ${providerName(payment)} but couldn't be recorded here. It shows as in progress: retry it to record it.`,
            { expose: true }))
    }

    res.send({ refund: findById(recorded.refunds, refundId), cart: await managerView(recorded) })
}

// (b) then (c) for the pending refund `refundId` on `cart`. Its id is the
// provider's idempotency key, so sending it again (retryRefund) can't refund
// twice.
const sendRefund = async (
    req: Req, res: Res, next: Next,
    cart: ICartDocument, payment: IPayment, refundId: unknown, amount: number
) => {
    // (b)
    let providerRefundId: string | undefined
    try {
        ({ providerRefundId } = await refundPayment(payment, amount, String(refundId), cart._id))
    } catch (error) {
        const reason = (error as Error).message
        // No clear answer (a timeout, a 5xx): the refund may have gone
        // through. It stays pending, holding its units, so they can't be
        // refunded a second time under a new request id.
        if (!(error instanceof RefundRefused)) {
            console.error("Refund outcome unknown", { cartId: cart._id, refundId, reason })
            await keepOrderInStep(cart, payment._id)
            return next(createError(502,
                `${providerName(payment)} didn't confirm the refund (${reason}). It shows as in progress: retry it, which checks with ${providerName(payment)} first.`,
                { expose: true }))
        }
        await markFailed(cart, payment, refundId, reason)
        return next(createError(502, `${reason}. Nothing was refunded.`, { expose: true }))
    }

    // (c)
    await recordRefund(req, res, next, cart, payment, refundId, providerRefundId)
}

export const refundItems: TController = async ( req, res, next ) => {
    try {
        const { shopId, cartId } = req.params
        const { paymentId, lines, reason, reasonNote } = req.body as { paymentId: string; lines: RefundLine[]; reason?: RefundReason; reasonNote?: string }
        const user = req.user as IUserDocument

        const cart = await loadShopCart(shopId, cartId)
        if (!cart) return next(createError(404, "Cart Not Found!"))
        const payment = findById(cart.payments, paymentId)
        if (!payment) return next(createError(404, "Payment Not Found!"))
        if (payment.status === "pending") {
            return next(createError(409, `${providerName(payment)} hasn't confirmed this payment yet: check it first`))
        }
        if (payment.status === "failed") {
            return next(createError(409, `This payment didn't go through at ${providerName(payment)}: nothing was taken`))
        }
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
        const amount = round2(refundLines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0))

        // (a)
        cart.refunds.push({
            paymentId: payment._id as never,
            lines: refundLines.map(({ menuId, name, qty }) => ({ menuId, name, qty })),
            amount,
            currency: payment.currency,
            status: "pending",
            byUserId: user._id,
            at: new Date(),
            reason,
            reasonNote,
        })
        const refundId = cart.refunds[cart.refunds.length - 1]._id
        if (!(await saveChecked(cart))) return next(createError(409, CART_CHANGED))

        await sendRefund(req, res, next, cart, payment, refundId, amount)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// POST /shops/:shopId/carts/:cartId/refunds/:refundId/retry
// Settles a refund left in progress (the provider's answer was unclear, or it
// went through but couldn't be recorded). First asks the provider whether it
// has the refund, by its id: if so it's recorded as the provider says. If not,
// it's sent again under the same id, which the provider can't apply twice.
export const retryRefund: TController = async ( req, res, next ) => {
    try {
        const { shopId, cartId, refundId } = req.params
        const cart = await loadShopCart(shopId, cartId)
        if (!cart) return next(createError(404, "Cart Not Found!"))
        const refund = findById(cart.refunds, refundId)
        if (!refund) return next(createError(404, "Refund Not Found!"))
        if (refund.status !== "pending") return next(createError(409, "This refund isn't in progress any more"))
        const payment = findById(cart.payments, refund.paymentId)
        if (!payment) return next(createError(404, "Payment Not Found!"))

        let found: Awaited<ReturnType<typeof findProviderRefund>>
        try {
            found = await findProviderRefund(payment, String(refund._id))
        } catch (error) {
            return next(createError(502,
                `Couldn't check with ${providerName(payment)} (${(error as Error).message}). The refund is still in progress: try again shortly.`,
                { expose: true }))
        }

        if (found?.failed) {
            const reason = `${providerName(payment)} says this refund failed`
            await markFailed(cart, payment, refund._id, reason)
            return next(createError(502, `${reason}. Nothing was refunded.`, { expose: true }))
        }
        if (found) return await recordRefund(req, res, next, cart, payment, refund._id, found.providerRefundId)
        await sendRefund(req, res, next, cart, payment, refund._id, refund.amount)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------
// POST /shops/:shopId/carts/:cartId/payments/:paymentId/check
// Asks the provider about a payment it hadn't confirmed at checkout (see the
// cart model's `payments.status`). Confirmed: it becomes `completed`, and the
// cart closes if that was all it was waiting for. Failed: it becomes `failed`
// and its units are unpaid again, back in the payer's selection so they can
// pay another way (the cart reopens if it had closed). Still pending: nothing
// changes (409). Answers { payment, cart }; the payer is told (a note on the
// cart, or for a card payment its record's notice).

// The payment's units back to unpaid: its items' paid count, and the payer's
// paid selections of it (those paid at its time) reopened, into the payer's
// open selection of the item if they've made one since (one per item).
const unsettle = (cart: ICartDocument, payment: IPayment) => {
    const payer = String(payment.userId)
    for (const line of payment.lines) {
        const menuId = String(line.menuId)
        const item = cart.items.find((i) => String(i.menuId) === menuId)
        if (item) item.qtyPayed = Math.max(0, item.qtyPayed - line.qty)
        const ofPayer = (s: ICartDocument["split"][number]) => String(s.menuId) === menuId && String(s.userId) === payer
        for (const s of cart.split) {
            if (s.splitStatus !== "closed" || !ofPayer(s) || s.paidAt?.getTime() !== payment.paidAt.getTime()) continue
            const open = cart.split.find((o) => o.splitStatus === "open" && ofPayer(o))
            if (open) {
                open.qty += s.qty
                s.qty = 0
            } else {
                s.splitStatus = "open"
                s.unitPrice = undefined
                s.paidAt = undefined
            }
        }
    }
    cart.split = cart.split.filter((s) => s.qty > 0)
}

// A card payment's record follows its status (stripeCheckout.ts), from the
// cart as it is: run on every check, before anything refuses, so a record left
// behind by a crash between the cart's save and its own is repaired (its
// order too). Whether it worked: a failure is logged, and the check goes on
// without it.
const syncPaymentRecord = async (cart: ICartDocument, payment: IPayment) => {
    if (!hasCheckoutRecord(payment)) return true
    try {
        await syncRecordFromCart(cart, payment.providerCheckoutId, payment)
        return true
    } catch (error) {
        console.error("Card payment record not updated", { cartId: String(cart._id), paymentId: String(payment._id), error })
        return false
    }
}

// A pending payment of cart `cartId` settled as `status` (the provider's
// answer), by `actor` (none: the server): the cart's save, its order, and the
// payer told (a card payment's by its record: checkPendingPayment syncs it).
// The saved cart, or null if it never saved (other writes kept landing).
// `providerPaymentId`: the provider's id for the money, when the payment was
// recorded before it had one (a card payment still processing: refunds go
// against it).
const settlePendingPayment = async (
    cartId: unknown, paymentId: string, status: Exclude<PaymentStatus, "pending">, actor: unknown, providerPaymentId?: string
) => {
    const saved = await withFreshCart(cartId, (c) => {
        const p = findById(c.payments, paymentId)
        if (p?.status !== "pending") return
        const amount = money(p.amount, p.currency)
        p.status = status
        if (!p.providerPaymentId && providerPaymentId) p.providerPaymentId = providerPaymentId
        // A card payment's payer hears it from its record's notice (which
        // outlives a deleted or merged cart): no note as well.
        const tell = (message: string) => { if (!hasCheckoutRecord(p)) note(c, message, p.userId) }
        if (status === "completed") {
            tell(`${providerName(p)} confirmed your payment of ${amount}.`)
            log(c, actor, "checkPayment", `${amount} confirmed (payment ${paymentId})`)
            closeIfPaidOff(c)
        } else {
            unsettle(c, p)
            // Its units are owed again, so the cart must take payments:
            // reopened if it had closed (a second open cart on the table
            // is flagged, for the manager to merge).
            c.status = "open"
            tell(`${providerName(p)} didn't complete your payment of ${amount}, so nothing was taken. Those items are unpaid again.`)
            log(c, actor, "checkPayment", `${amount} failed at ${providerName(p)} (payment ${paymentId}): its items are unpaid again`)
        }
    })
    if (!saved) return null
    await keepOrderInStep(saved, paymentId)
    return saved
}

// A payment's check with its provider, shared by the manager's check below and
// the Stripe webhook (S34): its card payment record synced first, always,
// then a pending payment settled as the provider says, by `actor` (none: the
// server), and its record synced from the payment as saved (another check may
// have settled it first). `synced`: whether the record ended in step (the
// last sync worked: after a settle, the one from the saved payment). The
// manager's check goes on without (the next check repairs it); the webhook
// has Stripe retry, since no check may come once the payment is settled.
type Check =
    | { kind: "notPending" }
    | { kind: "unreachable"; error: Error }
    | { kind: "stillPending" }
    | { kind: "lost" }
    | { kind: "settled"; saved: ICartDocument }
export type PaymentCheck = Check & { synced: boolean }
export const checkPendingPayment = async (cart: ICartDocument, payment: IPayment, actor: unknown): Promise<PaymentCheck> => {
    const synced = await syncPaymentRecord(cart, payment)
    if (payment.status !== "pending") return { kind: "notPending", synced }

    let status: PaymentStatus
    let providerPaymentId: string | undefined
    try {
        ({ status, providerPaymentId } = await checkProviderPayment(payment))
    } catch (error) {
        return { kind: "unreachable", error: error instanceof Error ? error : new Error(String(error)), synced }
    }
    if (status === "pending") return { kind: "stillPending", synced }

    const saved = await settlePendingPayment(cart._id, String(payment._id), status, actor, providerPaymentId)
    if (!saved) return { kind: "lost", synced }
    // The last sync is the one that counts: it brings the record to the end.
    const settled = findById(saved.payments, String(payment._id))
    return { kind: "settled", saved, synced: settled ? await syncPaymentRecord(saved, settled) : false }
}

export const checkPayment: TController = async ( req, res, next ) => {
    try {
        const { shopId, cartId, paymentId } = req.params
        const cart = await loadShopCart(shopId, cartId)
        if (!cart) return next(createError(404, "Cart Not Found!"))
        const payment = findById(cart.payments, paymentId)
        if (!payment) return next(createError(404, "Payment Not Found!"))

        const check = await checkPendingPayment(cart, payment, managerOf(req))
        switch (check.kind) {
            case "notPending":
                return next(createError(409, "This payment isn't awaiting confirmation any more"))
            case "unreachable":
                return next(createError(502,
                    `Couldn't check with ${providerName(payment)} (${check.error.message}). Try again shortly.`,
                    { expose: true }))
            case "stillPending":
                return next(createError(409, `${providerName(payment)} is still processing this payment. Check again later`))
            case "lost":
                return next(createError(409, CART_CHANGED))
        }
        res.send({ payment: findById(check.saved.payments, paymentId), cart: await managerView(check.saved) })
    } catch (error) {
        next(createError(500, error as Error))
    }
}


// A manager's refund Stripe accepted, then couldn't make (the webhook's
// refund.failed, S34/S35), by its entry `requestId` on cart `cartId`. Not
// reversed here (decided 2026-10-07): the diner is owed it, so one the cart
// has as completed becomes a pay-back (once) and a line for the managers. One
// still pending here is asked for again ("retry"), once it's settled one way
// or the other; one marked failed here already (its retry found it) can be
// refunded again, so nothing is owed. A cart that's gone, or an id that isn't
// one (metadata edited by hand), is only logged; a cart still here whose
// refund can't be found on it is told to look at Stripe. `what` says which
// refund, for the log and the lines.
export const managerRefundFailed = async (
    cartId: string, requestId: string, what: string, { intentId, failureReason }: { intentId?: string; failureReason?: string | null }
): Promise<"done" | "retry"> => {
    const about = { paymentIntentId: intentId, cartId, refundId: requestId }
    if (!mongoose.isValidObjectId(cartId)) {
        console.error(`A card ${what}, with metadata that isn't UnQ's`, about)
        return "done"
    }
    const cart = await CartModel.findById(cartId).select("tableId shopId refunds payments")
    if (!cart) {
        console.error(`A card ${what}, and its cart is gone`, about)
        return "done"
    }
    const ours = mongoose.isValidObjectId(requestId) ? cart.refunds.find((r) => String(r._id) === requestId) : undefined
    if (!ours) {
        console.error(`A card ${what}, and that refund isn't on its cart`, about)
        await logOnce(cartId, "stripeRefundFailed", `${what}: it isn't on this cart, so check it in Stripe's dashboard`)
        return "done"
    }
    if (ours.status === "pending") {
        console.error(`A card ${what} while still pending here: Stripe sends it again`, about)
        return "retry"
    }
    console.error(`A card ${what}`, about)
    if (ours.status === "failed") {
        await logOnce(cartId, "stripeRefundFailed", `${what}: it's marked failed here, so refund those items again`)
        return "done"
    }
    const disputed = isDisputeReason(failureReason)
    const payment = cart.payments.find((p) => String(p._id) === String(ours.paymentId))
    const shopId = await shopIdOfCart(cart)
    if (payment && shopId) {
        await writePayback({
            kind: "refundFailed", shopId, tableId: cart.tableId, cartId: cart._id, userId: payment.userId,
            amount: ours.amount, paymentAmount: payment.amount, currency: ours.currency, refundId: ours._id,
            ...(intentId && { paymentIntentId: intentId }),
            ...(disputed && { disputed: true }),
        })
    } else {
        console.error("…and its pay-back couldn't be written (no payment or shop)", about)
    }
    await logOnce(cartId, "stripeRefundFailed", disputed
        ? `${what}: the diner disputes the payment with their bank, so don't pay it back yourselves (see the table's pay-backs)`
        : `${what}: it wasn't reversed here, so pay the diner back another way`)
    return "done"
}
