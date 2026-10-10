import mongoose from "mongoose"
import { ICartDocument } from "src/typings/cart"
import { IOrder } from "src/typings/order"
import OrderModel from "./model"
import CartModel from "../carts/model"
import MenuModel from "../menus/model"
import ShopModel, { ofTable } from "../shops/model"
import { isDuplicateKey } from "../../lib/mongo"

type Outcome = "created" | "updated" | "unchanged"

const id = (value: unknown) => String(value)

// The cart's shop (a cart saved without one: the shop holding its table), with
// only that table, current or deleted, for its name.
const shopAndTable = async (cart: ICartDocument) => {
    const tableId = mongoose.isValidObjectId(cart.tableId) ? new mongoose.Types.ObjectId(cart.tableId) : null
    const shop = await ShopModel.findOne(cart.shopId ? { _id: cart.shopId } : ofTable(cart.tableId))
        .select(tableId ? { tables: { $elemMatch: { _id: tableId } }, deletedTables: { $elemMatch: { _id: tableId } } } : { _id: 1 })
        .lean()
    const table = [...(shop?.tables ?? []), ...(shop?.deletedTables ?? [])].at(0)
    return { shopId: cart.shopId ?? shop?._id, tableName: table?.name }
}
type Place = Awaited<ReturnType<typeof shopAndTable>>

const refundsOf = (cart: ICartDocument, paymentId: unknown) => cart.refunds.filter((r) => id(r.paymentId) === id(paymentId))

// The carts matching `filter` with a payment, a cart at a time (so a long
// history isn't held in memory at once), with what syncOrder reads.
const paidCarts = (filter: object) =>
    CartModel.find({ $and: [filter, { "payments.0": { $exists: true } }] }).select("shopId tableId payments refunds createdAt __v")

// The order of one of the cart's payments, rebuilt from the cart as saved: the
// payment, its refunds, the table's name, each line's category. Every change to
// a payment or refund is a version-checked save (never an update operator),
// which moves the cart's __v, so an order is written only over one built from
// the same or an older version: two syncs finishing out of order can't leave
// the older one's. The table name is kept from the first write that found it.
// `place` saves the shop lookup when the caller has it (the repair script, for
// a cart's other payments). Throws if it can't be written.
export const syncOrder = async (
    cart: ICartDocument,
    paymentId: unknown,
    place?: Place
): Promise<Outcome> => {
    const payment = cart.payments.find((p) => id(p._id) === id(paymentId))
    if (!payment) throw new Error(`Cart ${cart._id} has no payment ${paymentId}`)
    const { createdAt, __v: version } = cart as unknown as { createdAt?: Date; __v?: number }
    // Required on the order; update validators don't catch a missing one.
    if (!createdAt || version == null) throw new Error(`Cart ${cart._id} has no creation date or version`)

    const { shopId, tableName } = place ?? await shopAndTable(cart)
    if (!shopId) throw new Error(`No shop found for cart ${cart._id}`)

    // Lines paid before categories were kept: the category their order already
    // has (so a later menu change doesn't move past sales), else their item's
    // now, if it still exists.
    const known = new Map<string, string>()
    let missing = payment.lines.filter((l) => l.category == null).map((l) => l.menuId)
    if (missing.length > 0) {
        const existing = await OrderModel.findOne({ paymentId: payment._id }).select("lines.menuId lines.category").lean()
        for (const l of existing?.lines ?? []) if (l.category != null) known.set(id(l.menuId), l.category)
        missing = missing.filter((m) => !known.has(id(m)))
    }
    if (missing.length > 0) {
        for (const m of await MenuModel.find({ _id: { $in: missing } }).select("category").lean()) known.set(id(m._id), m.category)
    }

    const order: Omit<IOrder, "paymentId" | "tableName"> = {
        cartId: cart._id as IOrder["cartId"],
        cartOpenedAt: createdAt,
        cartVersion: version,
        shopId,
        tableId: cart.tableId,
        payerId: payment.userId,
        // Payments recorded before statuses existed read as completed.
        status: payment.status ?? "completed",
        paidAt: payment.paidAt,
        currency: payment.currency,
        amount: payment.amount,
        provider: payment.provider,
        providerCheckoutId: payment.providerCheckoutId,
        ...(payment.providerPaymentId && { providerPaymentId: payment.providerPaymentId }),
        lines: payment.lines.map((l) => ({
            menuId: l.menuId,
            name: l.name,
            category: l.category ?? known.get(id(l.menuId)) ?? null,
            unitPrice: l.unitPrice,
            qty: l.qty,
            refundedQty: l.refundedQty ?? 0,
        })),
        refunds: refundsOf(cart, payment._id).map((r) => ({
                refundId: r._id!,
                status: r.status,
                at: r.at,
                amount: r.amount,
                lines: r.lines.map(({ menuId, name, qty }) => ({ menuId, name, qty })),
                ...(r.reason && { reason: r.reason }),
                ...(r.reasonNote && { reasonNote: r.reasonNote }),
            })),
    }

    const filter = { paymentId: payment._id, cartVersion: { $lte: version } }
    const write = (upsert: boolean) => OrderModel.updateOne(
        filter,
        { $set: order, $setOnInsert: tableName ? { tableName } : {} },
        { upsert, runValidators: true }
    )
    let outcome: Outcome
    try {
        const result = await write(true)
        outcome = result.upsertedCount ? "created" : result.modifiedCount ? "updated" : "unchanged"
    } catch (error) {
        if (!isDuplicateKey(error)) throw error
        // The order exists: from a newer cart (the filter missed it: nothing to
        // do), or created by another sync at the same moment (written now, if
        // this cart is as new).
        outcome = (await write(false)).modifiedCount ? "updated" : "unchanged"
    }
    // A table name an earlier write couldn't find (a created order has it).
    if (tableName && outcome !== "created") {
        await OrderModel.updateOne({ paymentId: payment._id, tableName: { $exists: false } }, { $set: { tableName } })
    }
    return outcome
}

// What of a payment its order must match: its status, what's refunded of each
// line, and each of its refunds' status. (The cart's version moves with any
// save, a closed table or a note too, so it can't say an order is behind.)
const moneyState = (status: string | undefined, refundedQty: number[], refunds: { id: unknown; status: string }[]) =>
    JSON.stringify([status ?? "completed", refundedQty, refunds.map((r) => [id(r.id), r.status])])

// Every order of `shop`'s carts (those `carts` matches) written where it's
// missing or doesn't match its payment (shop deletion, before the carts go: a
// sync that failed earlier). Throws if one can't be.
export const SHOP_DELETION_READ = "shop deletion: its paid carts' orders"
export const keepShopOrders = async (
    carts: object,
    shop: { _id: unknown; tables: { _id?: unknown; name: string }[]; deletedTables: { _id?: unknown; name: string }[] }
) => {
    const tables = [...shop.tables, ...shop.deletedTables]
    for await (const cart of paidCarts(carts).comment(SHOP_DELETION_READ)) {
        const orders = await OrderModel.find({ paymentId: { $in: cart.payments.map((p) => p._id!) } })
            .select("paymentId status lines.refundedQty refunds.refundId refunds.status")
            .lean<{ paymentId: unknown; status: string; lines: { refundedQty: number }[]; refunds: { refundId: unknown; status: string }[] }[]>()
        const kept = new Map(orders.map((o) => [id(o.paymentId), moneyState(o.status, o.lines.map((l) => l.refundedQty), o.refunds.map((r) => ({ id: r.refundId, status: r.status })))]))
        // The shop in hand: its carts are its own or at its tables.
        const place: Place = {
            shopId: shop._id as Place["shopId"],
            tableName: tables.find((t) => id(t._id) === cart.tableId)?.name,
        }
        for (const payment of cart.payments) {
            const now = moneyState(
                payment.status,
                payment.lines.map((l) => l.refundedQty ?? 0),
                refundsOf(cart, payment._id).map((r) => ({ id: r._id, status: r.status }))
            )
            if (kept.get(id(payment._id)) === now) continue
            await syncOrder(cart, payment._id, place)
        }
    }
}

// syncOrder for a route that has already moved money: a failure is logged,
// never answered, and the repair script writes the order later.
export const keepOrderInStep = async (cart: ICartDocument, paymentId: unknown) => {
    try {
        await syncOrder(cart, paymentId)
    } catch (error) {
        console.error("Order not written; run npx tsx src/scripts/syncOrders.ts", { cartId: String(cart._id), paymentId: String(paymentId), error })
    }
}

// Every cart payment's order, written or brought up to date (the repair and
// backfill script). Idempotent. A payment whose order can't be written is
// logged and counted, and the rest go on.
export const syncAllOrders = async () => {
    const counts: Record<Outcome | "failed", number> = { created: 0, updated: 0, unchanged: 0, failed: 0 }
    for await (const cart of paidCarts({})) {
        // The shop looked up once for the cart's payments.
        let place: Place | undefined
        for (const payment of cart.payments) {
            try {
                place ??= await shopAndTable(cart)
                counts[await syncOrder(cart, payment._id, place)]++
            } catch (error) {
                counts.failed++
                console.error("Order not written", { cartId: String(cart._id), paymentId: String(payment._id), error })
            }
        }
    }
    return counts
}
