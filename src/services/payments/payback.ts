import mongoose from "mongoose"
import CartModel from "../carts/model"
import { isDuplicateKey } from "../../lib/mongo"

const { Schema, model } = mongoose

// Money staff must give a diner back another way, because Stripe won't (S35):
// one per payment handed to staff (`refundRefused`: its late refund failed for
// good, see stripeFinish.ts's tellStaff) and per manager's card refund Stripe
// failed after accepting it (`refundFailed`, the webhook). Kept apart from the
// cart, which may be closed and deleted before a hand-over (nothing was
// recorded on it). Shown on the table's sheet (owed, and done in the last 30
// days) and flagged on its card until a manager marks it done. Never shown to
// diners.
// - amount: what's owed, in pounds (the cart's money fields' unit); for
//   `refundFailed`, `paymentAmount` is the whole payment's (a dispute is of
//   all of it).
// - paymentIntentId: Stripe's, to find it in the dashboard. refundId: UnQ's
//   cart refund (`refundFailed`).
// - disputed: Stripe won't refund it because the diner disputes the payment:
//   their bank returns it, staff don't.
// - owed: true until done, then unset (what the indexes and queries use; a
//   partial index can't filter on a missing field). doneAt, doneByUserId,
//   doneAs: who marked it, when, and as what ("paidBack", "handled": a dispute,
//   "checked": a payment a cart shows as paid).
export const PAYBACK_KINDS = ["refundRefused", "refundFailed"] as const
export const DONE_AS = ["paidBack", "handled", "checked"] as const
export type DoneAs = (typeof DONE_AS)[number]

export interface IPayback {
    _id: mongoose.Types.ObjectId
    shopId: mongoose.Types.ObjectId
    tableId: string
    cartId: mongoose.Types.ObjectId
    kind: (typeof PAYBACK_KINDS)[number]
    userId: mongoose.Types.ObjectId
    amount: number
    currency: string
    paymentIntentId?: string
    refundId?: mongoose.Types.ObjectId
    paymentAmount?: number
    disputed?: boolean
    owed?: boolean
    at: Date
    doneAt?: Date
    doneByUserId?: mongoose.Types.ObjectId
    doneAs?: DoneAs
}

const PaybackSchema = new Schema<IPayback>({
    shopId: { type: Schema.Types.ObjectId, required: true },
    tableId: { type: String, required: true },
    cartId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: PAYBACK_KINDS, required: true },
    userId: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    paymentIntentId: String,
    refundId: Schema.Types.ObjectId,
    paymentAmount: Number,
    disputed: Boolean,
    owed: Boolean,
    at: { type: Date, required: true },
    doneAt: Date,
    doneByUserId: { type: Schema.Types.ObjectId, ref: "User" },
    doneAs: { type: String, enum: DONE_AS },
}, { versionKey: false })

// One per hand-over and per failed manager refund: a repeat (Stripe's event
// again, the sweep, a retry) hits the key and is taken as done.
PaybackSchema.index({ paymentIntentId: 1 }, { unique: true, partialFilterExpression: { kind: "refundRefused" } })
PaybackSchema.index({ refundId: 1 }, { unique: true, partialFilterExpression: { kind: "refundFailed" } })
// A shop's (the owed ones for its tables' attention and deleting it, all of
// them to delete with it: few per shop), and a table's owed ones.
PaybackSchema.index({ shopId: 1 })
PaybackSchema.index({ tableId: 1, owed: 1 }, { partialFilterExpression: { owed: true } })
// A table's done ones, recent first (its sheet shows 30 days).
PaybackSchema.index({ tableId: 1, doneAt: 1 }, { partialFilterExpression: { doneAt: { $exists: true } } })

const PaybackModel = model<IPayback>("Payback", PaybackSchema)
export default PaybackModel

// A diner as a line for staff names them (first name only).
export const dinerName = (user: { name?: string } | null | undefined) =>
    user ? user.name || "a diner with no name" : "a diner whose account is gone"

// A pay-back written once: a repeat is already done.
export const writePayback = async (payback: Omit<IPayback, "_id" | "owed" | "at">) => {
    try {
        await PaybackModel.create({ ...payback, owed: true, at: new Date() })
    } catch (error) {
        if (!isDuplicateKey(error)) throw error
    }
}

// A table's sheet shows its owed pay-backs and those done in the last 30 days.
export const PAYBACKS_DONE_SHOWN_MS = 30 * 24 * 60 * 60 * 1000

// Whether a cart shows this payment as paid (a holder that stalled past its
// lease can record it after it was handed over): worked out when read, never
// stored, as it can become true later.
export const recordedOnCart = async (paymentIntentId: string | undefined) =>
    !!paymentIntentId && !!(await CartModel.exists({ stripePaymentIntentIds: paymentIntentId }))

// A pay-back as managers read it: the diner and the manager who marked it by
// first name (null: account gone), and `recorded` for a hand-over a cart now
// shows as paid.
const NAMES = [
    { path: "userId", select: "name", options: { lean: true } },
    { path: "doneByUserId", select: "name", options: { lean: true } },
]
export const forManagers = async (paybacks: IPayback[]) => {
    const handedOver = paybacks.filter((p) => p.owed && p.kind === "refundRefused" && p.paymentIntentId).map((p) => p.paymentIntentId!)
    const onCarts = handedOver.length
        ? new Set((await CartModel.find({ stripePaymentIntentIds: { $in: handedOver } }).select("stripePaymentIntentIds").lean())
            .flatMap((c) => c.stripePaymentIntentIds ?? []))
        : new Set<string>()
    const named = await PaybackModel.populate(paybacks, NAMES)
    return named.map((p) => ({
        ...p,
        ...(p.owed && p.kind === "refundRefused" && onCarts.has(p.paymentIntentId!) && { recorded: true }),
    }))
}

// A table's pay-backs for its sheet, newest first. Two queries, each on its
// own partial index (one query with an $or can't be planned on them).
export const tablePaybacks = async (tableId: string) => {
    const since = new Date(Date.now() - PAYBACKS_DONE_SHOWN_MS)
    const [owed, done] = await Promise.all([
        PaybackModel.find({ tableId, owed: true }).lean(),
        PaybackModel.find({ tableId, doneAt: { $exists: true, $gte: since } }).lean(),
    ])
    return forManagers([...owed, ...done].sort((a, b) => b.at.getTime() - a.at.getTime()))
}
