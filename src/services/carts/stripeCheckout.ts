import mongoose from "mongoose"
import { ICartDocument, INotice, IPayment } from "src/typings/cart"
import { NOTICE_MAX_AGE_MS } from "./model"
import { money } from "../../lib/money"
import { keepOrderInStep } from "../orders/sync"

const { Schema, model } = mongoose

// One card payment's record: a Stripe PaymentIntent created by
// createStripeCheckout, written right after Stripe creates it, so every intent
// UnQ made has one the sweep can find. It says who is finishing the intent (the
// route, the webhook or the sweep: one at a time, see stripeFinish.ts) and how
// it ended. Kept as an audit trail.
//
// - state: `open` (nobody is finishing it) → `finishing` (claimed), or
//   `releasing` (a holder decided to cancel it; whoever finishes it later only
//   completes the cancel) → `recorded` (on a cart), `released` (cancelled,
//   nothing taken) or `refunded` (captured, then refunded in full).
// - token, leaseUntil: the current holder's claim. Every write a holder makes
//   matches its token; a lease that ran out can be taken over.
// - amount: in pence, as created (the notices' £X, since the cart may be gone).
// - checkedAt: the sweep's last look at an `open` record; reportedAt: when it
//   logged one still unfinished two hours after it was created (once).
// - confirmed: the diner went past entering their card (an authorisation, a
//   bank check, a capture, or a route that answered "still confirming"). Only
//   then do they get a notice of the outcome.
// - finishedAt, paymentStatus: when it reached a final state (or its payment's
//   status last changed), and that status (`recorded` only).
// - answered, answeredBy: the outcome the diner's own request gave them
//   (outcomeKey), and the stamps of the requests that gave it (each takes
//   back only its own part, if the diner didn't read it). A final, confirmed record whose
//   outcome isn't the one answered is shown as a notice (paymentNotices):
//   so a later outcome (pending, then completed or failed; a release
//   overtaken by the capture) is told, with nothing to unset.
// - status, message: the answer given for a `released` or `refunded` intent,
//   the same to every caller (and for one being refunded, `refunding`: a
//   holder decided to refund it, so later ones only complete the refund;
//   refundRetryAt: when one Stripe refused is tried again; refundId: the
//   refund a `refunded` one ended with, when its holder made it, so a failure
//   Stripe reports later reopens it, see reopenFailedRefund).
// - settleFailingSince: when saving its captured payment first failed (an
//   error, not a lost race): retried for an hour from then, then refunded.
export const CHECKOUT_STATES = ["open", "finishing", "releasing", "recorded", "released", "refunded"] as const
export type CheckoutState = (typeof CHECKOUT_STATES)[number]
export type FinalState = "recorded" | "released" | "refunded"
export const FINAL_STATES: CheckoutState[] = ["recorded", "released", "refunded"]

export interface IStripeCheckout {
    _id: string
    cartId: mongoose.Types.ObjectId
    tableId: string
    userId: mongoose.Types.ObjectId
    amount: number
    state: CheckoutState
    token?: string
    leaseUntil?: Date
    checkedAt?: Date
    reportedAt?: Date
    confirmed: boolean
    finishedAt?: Date
    paymentStatus?: "completed" | "pending" | "failed"
    answered?: string
    answeredBy?: string[]
    status?: number
    message?: string
    refunding?: boolean
    refundId?: string
    settleFailingSince?: Date
    refundRetryAt?: Date
    createdAt: Date
    updatedAt: Date
}

const StripeCheckoutSchema = new Schema<IStripeCheckout>(
    {
        _id: { type: String, required: true },
        cartId: { type: Schema.Types.ObjectId, required: true },
        tableId: { type: String, required: true },
        userId: { type: Schema.Types.ObjectId, required: true },
        amount: { type: Number, required: true },
        state: { type: String, enum: CHECKOUT_STATES, default: "open" },
        token: String,
        leaseUntil: Date,
        checkedAt: Date,
        reportedAt: Date,
        confirmed: { type: Boolean, default: false },
        finishedAt: Date,
        paymentStatus: { type: String, enum: ["completed", "pending", "failed"] },
        answered: String,
        answeredBy: { type: [String], default: undefined },
        status: Number,
        message: String,
        refunding: Boolean,
        refundId: String,
        settleFailingSince: Date,
        refundRetryAt: Date,
    },
    { timestamps: true }
)

// The sweep's records still unfinished, oldest first. Not partial: a filter on
// three states needs $in, which partial indexes take only from MongoDB 6.0, and
// the collection stays small.
StripeCheckoutSchema.index({ state: 1, createdAt: 1 })
// A diner's outcomes at a table, for their notices: only finished ones.
StripeCheckoutSchema.index(
    { userId: 1, tableId: 1, finishedAt: 1 },
    { partialFilterExpression: { finishedAt: { $exists: true } } }
)

const StripeCheckoutModel = model<IStripeCheckout>("StripeCheckout", StripeCheckoutSchema)
export default StripeCheckoutModel

// What the diner is told of an outcome they didn't hear from their own request.
const noticeText = (record: IStripeCheckout) => {
    const amount = money(record.amount / 100, "GBP")
    switch (record.state) {
        case "recorded":
            if (record.paymentStatus === "pending") return `Your card payment of ${amount} is being confirmed: your items are held for you`
            if (record.paymentStatus === "failed") return `Your card payment of ${amount} didn't go through: nothing was taken. Those items are unpaid again.`
            return `Your card payment of ${amount} went through`
        case "released":
            return `Your card payment of ${amount} didn't go through: nothing was charged`
        default: {
            // Why, from the stored answer ("The table's cart changed while you
            // were paying — your payment was refunded").
            const why = record.message?.split(" — ")[0] ?? "it couldn't be recorded"
            return `Your card payment of ${amount} was refunded: ${why.charAt(0).toLowerCase()}${why.slice(1)}`
        }
    }
}

// An outcome as the diner hears it: how it ended, and for a recorded payment
// its status (pending, then completed or failed, are outcomes of their own).
export const outcomeKey = ({ state, paymentStatus }: { state: string; paymentStatus?: string }) =>
    state === "recorded" ? `recorded:${paymentStatus ?? "completed"}` : state

// The viewer's card payment outcomes at a table that their own request didn't
// answer, as notices: built from the records when read, so nothing can race
// them. Each outcome has its own id (a later outcome of the same payment is
// shown even after the earlier one was dismissed). For noticesFor, which sorts
// and caps them with the cart's.
export const paymentNotices = async (viewerId: unknown, tableId: string): Promise<INotice[]> => {
    if (!viewerId) return []
    const records = await StripeCheckoutModel.find({
        userId: viewerId,
        tableId,
        finishedAt: { $gte: new Date(Date.now() - NOTICE_MAX_AGE_MS) },
        state: { $in: FINAL_STATES },
        confirmed: true,
    }).lean()
    return records.filter((r) => r.answered !== outcomeKey(r)).map((r) => ({
        _id: `${r._id}:${r.state}:${r.paymentStatus ?? ""}:${r.finishedAt!.getTime()}`,
        at: r.finishedAt!,
        forUserId: r.userId,
        message: noticeText(r),
    }))
}

// The record follows its cart payment's status: on a change, it's `recorded`
// with the new status and when (a new outcome, so the diner gets a notice of
// it unless their request answers it). Matches
// only a real change, so a repeated check doesn't bring back a notice already
// seen. (The cart is the truth: a payment on a cart is recorded, whatever the
// record said; except one being or already refunded, saved by a holder that
// stalled past its lease after the refund was decided: the refund stands, and
// the manager is told.) A payment only moves on from pending, so never back
// to it: a sync from a copy of the cart read before a settle can't undo it.
const syncCheckoutRecord = (intentId: string, paymentStatus: "completed" | "pending" | "failed") =>
    StripeCheckoutModel.updateOne(
        {
            _id: intentId,
            state: { $ne: "refunded" },
            refunding: { $ne: true },
            $or: [{ state: { $ne: "recorded" } }, { paymentStatus: { $ne: paymentStatus } }],
            ...(paymentStatus === "pending" ? { $nor: [{ state: "recorded", paymentStatus: { $in: ["completed", "failed"] } }] } : {}),
        },
        { $set: { state: "recorded", paymentStatus, finishedAt: new Date() } }
    )

// The record of intent `intentId` synced from its payment on `cart` (as
// above). One this marks recorded may be a finisher's that stopped after
// saving the cart, before writing its order: written now (idempotent, so one
// just written is only checked again).
export const syncRecordFromCart = async (cart: ICartDocument, intentId: string, payment?: IPayment) => {
    const { modifiedCount } = await syncCheckoutRecord(intentId, payment?.status ?? "completed")
    if (modifiedCount > 0 && payment) await keepOrderInStep(cart, payment._id)
}
