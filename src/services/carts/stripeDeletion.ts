import mongoose from "mongoose"
import CartModel from "./model"
import StripeCheckoutModel, { HELD_STATES } from "./stripeCheckout"
import PaybackModel from "../payments/payback"
import { SHOP_DELETION_READ } from "../orders/sync"

// What card payments hold a shop's deletion for (S35, deleteMyShop). The shop
// goes with its carts, and pay-backs need it to be shown on, so it waits:
// - while a card payment is still being finished (it may yet be handed to
//   staff), or handed over and staff not told yet;
// - while a diner is still to be paid back (what the manager can do now);
// - for 30 days after a card refund last moved: a refund Stripe accepted can
//   fail that long after, even after Stripe said it succeeded.
// Card payments with no refund, PayPal refunds, refunds that already failed
// (a pay-back) and intents nobody confirmed (nothing held; cancelled in an
// hour, or released once confirmed, their cart gone) don't hold it.

// How long after a card refund last moved Stripe may still report it failed.
const CARD_REFUND_CAN_FAIL_MS = 30 * 24 * 60 * 60 * 1000
const dateOf = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })

// The refusal to answer (a 409's message), or null when nothing holds it.
// `itsCarts` matches the shop's carts and records (by shop or, for older
// ones, table); `tableName` names a table for the message.
export const cardMoneyHolding = async (
    shopId: mongoose.Types.ObjectId, itsCarts: object, tableIds: string[], tableName: (tableId: string) => string
): Promise<string | null> => {
    // The refunds Stripe still calls succeeded: the API's own (records
    // `refunded`; one that failed is handed over, and dealt with above) by
    // when they last moved, and the managers' by when they were made, on the
    // carts changed since the cutoff (a refund's change is one), a card
    // payment's and without a pay-back (failed already).
    const cutoff = new Date(Date.now() - CARD_REFUND_CAN_FAIL_MS)
    const latestRecord = (by: object) => StripeCheckoutModel
        .findOne({ refunding: true, state: "refunded", updatedAt: { $gte: cutoff }, ...by })
        .sort({ updatedAt: -1 }).select("updatedAt").lean()
    const [finishing, owed, byShop, byTable, carts, failed] = await Promise.all([
        StripeCheckoutModel.findOne({
            $and: [{ $or: [{ state: { $in: HELD_STATES } }, { state: "refundFailed", staffToldAt: { $exists: false } }] }, itsCarts],
        }).select("tableId refunding").lean(),
        PaybackModel.findOne({ shopId, owed: true }).select("tableId").lean(),
        latestRecord({ shopId }),
        latestRecord({ tableId: { $in: tableIds } }),
        CartModel.find({ $and: [itsCarts, {
            status: "closed", updatedAt: { $gte: cutoff }, "payments.provider": "stripe", "refunds.status": "completed",
        }] }).select("payments._id payments.provider refunds._id refunds.paymentId refunds.status refunds.at").comment(SHOP_DELETION_READ).lean(),
        PaybackModel.find({ shopId, kind: "refundFailed", at: { $gte: cutoff } }).select("refundId").lean(),
    ])
    if (finishing) {
        // Refunding: Stripe refused it for now, and it's retried (stripeFinish.ts's refund()).
        return finishing.refunding
            ? `A card refund at Table ${tableName(finishing.tableId)} is being retried at Stripe (every 30 minutes, for up to a day) — try again later`
            : `A card payment at Table ${tableName(finishing.tableId)} is still being finished — try again shortly`
    }
    if (owed) return `A diner at Table ${tableName(owed.tableId)} is still to be paid back — mark it done first`
    const failedIds = new Set(failed.map((p) => String(p.refundId)))
    const cardRefunds = carts.flatMap((cart) => {
        const cards = new Set(cart.payments.filter((p) => p.provider === "stripe").map((p) => String(p._id)))
        return cart.refunds
            .filter((r) => r.status === "completed" && cards.has(String(r.paymentId)) && !failedIds.has(String(r._id)))
            .map((r) => r.at.getTime())
    })
    const lastRefund = Math.max(byShop?.updatedAt.getTime() ?? 0, byTable?.updatedAt.getTime() ?? 0,
        ...cardRefunds.filter((at) => at >= cutoff.getTime()))
    if (lastRefund) {
        return `A card refund at this shop on ${dateOf(lastRefund)} can still fail at Stripe until ` +
            `${dateOf(lastRefund + CARD_REFUND_CAN_FAIL_MS)}: the shop can be deleted from then`
    }
    return null
}
