import { randomUUID } from "crypto"
import mongoose from "mongoose"
import CartModel from "./model"
import UserModel from "../users/model"
import StripeCheckoutModel, { FINAL_STATES, FinalState, IStripeCheckout, outcomeKey, syncRecordFromCart } from "./stripeCheckout"
import { checkoutCheck, settleCheckout, Settlement, SettleOutcome } from "./controllers"
import { keepOrderInStep } from "../orders/sync"
import {
    cancelIntent, captureIntent, chargeIdOf, createRefund, listRefunds, retrieveIntent, StripeCaptureRefused, StripeCharge, StripeIntent, StripeRefundRefused,
} from "../../lib/stripe"
import { money, toPence } from "../../lib/money"
import { log, logOnce } from "./managerControllers"
import { shopIdOfTable } from "../shops/model"
import { dinerName, writePayback } from "../payments/payback"

// Finishing a card payment: one procedure for the diner's capture call
// (captureStripeCheckout), the sweep below and the webhook (S34). The diner's
// card was only authorised; the server re-checks the cart, then captures or
// cancels (nothing taken), and refunds in full a race lost after the capture.
//
// Two rules hold throughout:
// - The cart is the truth for "paid": an intent in some cart's
//   `stripePaymentIntentIds` is recorded, whatever its record says, and a
//   recorded intent is never refunded or cancelled.
// - Only the holder of the intent's record acts on it (a claim: a token and a
//   lease), and it acts on the intent's status as Stripe reports it after the
//   claim. Every write it makes to the record matches its token; one that
//   matches nothing means someone else took over, and it stops (LostClaim).

// The route's wait for another finisher, how often it looks, and how long a
// claim lasts (well beyond Stripe's 20 s timeouts). Tests shorten the first two.
export const stripeTiming = { waitMs: 8000, pollMs: 500, leaseMs: 2 * 60 * 1000 }

// Who's asking, for the diner's own capture call: the route's cart, table and
// diner, and whether they're still there to read the answer.
// `stamp`: this request's mark on the outcome it answers (the record's
// answeredBy), so it can take back only its own.
export type Caller = { cartId: string; tableId: string; userId: string; connected: () => boolean; stamp: string }

// How it ended for this call:
// - answer: what the route sends (2xx: the cart `cartId`; else an error). A
//   500 means "try again" to the webhook.
// - busy: someone else holds it (the webhook answers 200; they finish it).
// - open: not authorised yet; left for the diner, the webhook or the sweep.
// - waiting: charged, its refund refused by Stripe and retried later by the
//   sweep (the webhook answers 200: nothing a retry of its own would change).
// - unknown: no record (not an intent UnQ made).
export type Outcome =
    | { kind: "answer"; status: number; message?: string; reason?: string; expose?: boolean; cartId?: string; final?: FinalState }
    | { kind: "busy" }
    | { kind: "open" }
    | { kind: "waiting" }
    | { kind: "unknown" }

type Answer = { status: number; message: string }

export const CART_GONE = "Your card payment went through, but this table's cart is no longer here"
export const CART_GONE_PENDING = "Your card payment is being confirmed, but this table's cart is no longer here"
// Its 404, with a machine-readable why (the frontend tells it from the other
// 404s, which mean nothing was charged).
export const cartGone = (pending: boolean) => pending
    ? { status: 404, message: CART_GONE_PENDING, reason: "CART_GONE_PENDING" }
    : { status: 404, message: CART_GONE, reason: "CART_GONE" }
const NOT_THIS_CHECKOUT: Outcome = { kind: "answer", status: 402, message: "This payment was not created for this checkout" }
const PAYMENT_FAILED: Answer = { status: 402, message: "This payment didn't go through: nothing was taken" }
const NOT_COMPLETED: Answer = { status: 402, message: "Payment not completed — nothing was charged" }
const CAPTURE_FAILED: Answer = { status: 402, message: "Card payment capture failed — nothing was charged" }
const AMOUNT_CHANGED: Answer = { status: 409, message: "Your selection changed since the order was created, please retry" }
// PayPal's REFUNDED_MARKER wording: the frontend tells the diner they were refunded.
const CART_CHANGED: Answer = { status: 409, message: "The table's cart changed while you were paying — your payment was refunded" }
const NOT_RECORDED: Answer = { status: 409, message: "Your payment could not be recorded — your payment was refunded" }

export const stillConfirmingAnswer = (id: string) => ({
    status: 502,
    message: `We're still confirming your payment. Your cart will update once it's confirmed, and you'll get a note if it doesn't go through — until then, please don't pay for these items again (payment ${id})`,
    reason: "STILL_CONFIRMING",
})
const stillConfirming = (id: string): Outcome => ({ kind: "answer", ...stillConfirmingAnswer(id), expose: true })
const contactStaffMessage = (id: string) => `We couldn't finish your payment — please contact staff (payment ${id})`
// Left for a later finisher (the webhook answers 500, so Stripe retries too).
const contactStaff = (id: string): Outcome => ({ kind: "answer", status: 500, message: contactStaffMessage(id), expose: true })
const notRefunded = (id: string) =>
    ({ kind: "answer" as const, status: 500, message: `Payment captured but could not be recorded or refunded — please contact staff (payment ${id})`, expose: true })
// Handed to staff (refundFailed): as above, or, for one the diner disputes,
// their bank returns it (staff are told not to pay it back).
const handedOverAnswer = (id: string, disputed?: boolean): Outcome => ({
    ...notRefunded(id),
    ...(disputed ? { message: `Payment captured but couldn't be refunded to your card while you dispute it: your bank returns it (payment ${id})` } : {}),
    final: "refundFailed",
})

// The statuses that say the diner got past entering their card (see the
// record's `confirmed`), and those of a captured intent.
const CONFIRMED_STATUSES = ["requires_action", "requires_capture", "succeeded", "processing"]
const CAPTURED_STATUSES = ["succeeded", "processing"]

// How long a captured payment that can't be saved is retried, from its first
// failed save, before it's refunded.
const SETTLE_RETRY_MS = 60 * 60 * 1000
// When a late refund Stripe refused is tried again (a short balance clears
// later; staff may refund it by hand meanwhile), and for how long from its
// first refusal before it's handed to staff (a disputed charge never clears).
const REFUND_RETRY_MS = 30 * 60 * 1000
export const REFUSED_FOR_MS = 24 * 60 * 60 * 1000
// How often a late refund Stripe accepted, then reported failed, is made again
// before it's handed to staff (reopenFailedRefund).
export const REFUND_REOPENS = 3
// Stripe's reasons for a failed refund that a new one would fail for too (the
// card is closed or blocked, the charge is disputed, or staff cancelled it):
// handed to staff at once. A refund's failure_reason, whether Stripe reports
// it later or at once, and, for one refused outright, the API's error code
// (a dispute, a charge Stripe can't refund) or the refund's status
// (`canceled`: see createRefund). Any other (a short balance, a decline, an
// unknown or new reason) may clear.
const FOR_GOOD = new Set([
    "expired_or_canceled_card", "lost_or_stolen_card", "charge_for_pending_refund_disputed", "merchant_request",
    "charge_disputed", "refund_disputed_payment", "charge_not_refundable", "canceled",
])
const wontClear = (reason: string | null | undefined) => FOR_GOOD.has(reason ?? "")
// Those that say the diner disputed the charge with their bank, and the
// dispute is open (Stripe refuses a refund for it): the dispute, not staff,
// gives them the money back. (Never the charge's `disputed`, which stays true
// once a dispute closes, won or lost.)
const DISPUTED = new Set(["charge_for_pending_refund_disputed", "charge_disputed", "refund_disputed_payment"])
// Whether Stripe's refund failure reason is the diner's dispute.
export const isDisputeReason = (reason: string | null | undefined) => DISPUTED.has(reason ?? "")

// What's still taken of intent `id`'s charge (pence), from the refunds Stripe
// lists for it: those failed or cancelled don't count, nor `failed` (one
// Stripe just reported failed, whatever its status or the charge's refunded
// total say yet). Null when it has no charge.
const stillTaken = async (id: string, failed?: string) => {
    const charge = chargeOf(await retrieveIntent(id))
    if (!charge) return null
    const refunds = await listRefunds(id)
    const refunded = refunds
        .filter((r) => r.id !== failed && r.status !== "failed" && r.status !== "canceled")
        .reduce((sum, r) => sum + r.amount, 0)
    return charge.amount - refunded
}

// What a handed-over record keeps (`refundFailed`): what's still taken (staff
// may have refunded part by hand), and whether Stripe's `reason` says the
// diner's dispute is open.
const handedOverFields = (owed: number | null, reason: string | null | undefined) => ({
    ...(owed !== null ? { refundOwed: owed } : {}),
    ...(DISPUTED.has(reason ?? "") ? { disputed: true } : {}),
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const leaseEnd = () => new Date(Date.now() + stripeTiming.leaseMs)

// Someone else took the claim over: stop, and answer as a finisher that lost it.
class LostClaim extends Error {}

// An answer the diner didn't read (they left before the reply was sent):
// this request's stamp taken off it, and the answer taken back once no
// request that gave it is left, so they get the notice.
// One atomic update (a pipeline, through the driver: Mongoose doesn't take
// pipelines by default).
export const takeBackAnswer = (id: string, stamp: string) => {
    const left = { $filter: { input: "$answeredBy", cond: { $ne: ["$$this", stamp] } } }
    const none = { $eq: [{ $size: left }, 0] }
    return StripeCheckoutModel.collection.updateOne({ _id: id as never, answeredBy: stamp }, [
        { $set: { answered: { $cond: [none, "$$REMOVE", "$answered"] }, answeredBy: { $cond: [none, "$$REMOVE", left] } } },
    ])
}

// The diner's request gives them `outcome` (its outcomeKey), if they're still
// there: awaited before the reply is built, which reads the records, so the
// outcome isn't in it twice (as the answer and as a notice). Only while the
// record still has that outcome (`matching`), never over a newer one. The
// same answer another request gave is shared (its stamp added), so either
// leaving takes back only its own part; a different one is replaced. One
// atomic update (see takeBackAnswer). Taken back if they left meanwhile.
const markAnswered = async (id: string, outcome: string, caller: Caller | undefined, matching: Record<string, unknown>) => {
    if (!caller?.connected()) return
    const stamps = { $cond: [{ $eq: ["$answered", outcome] }, { $setUnion: [{ $ifNull: ["$answeredBy", []] }, [caller.stamp]] }, [caller.stamp]] }
    await StripeCheckoutModel.collection.updateOne({ _id: id as never, ...matching }, [{ $set: { answeredBy: stamps, answered: outcome } }])
    await afterAnswer(id, caller)
}

// The diner left after the answer was marked: taken back.
const afterAnswer = async (id: string, caller: Caller | undefined) => {
    if (caller && !caller.connected()) await takeBackAnswer(id, caller.stamp)
}

// The route answers "still confirming": the diner will want to hear the outcome.
const stillConfirmingFor = async (id: string) => {
    await StripeCheckoutModel.updateOne({ _id: id }, { $set: { confirmed: true } })
    return stillConfirming(id)
}

// The cart that recorded intent `id` (open or closed), and its payment.
export const cardPaymentOf = async (id: string) => {
    const cart = await CartModel.findOne({ stripePaymentIntentIds: id })
    const payment = cart?.payments.find((p) => p.provider === "stripe" && p.providerCheckoutId === id)
    return { cart, payment }
}

// Step 2: the intent on a cart (open or closed) is recorded, and the answer is
// that cart's payment's: completed 200, pending 202, failed 402. Its record is
// made to say so. Null when no cart has it, or when its record says it's being
// or was refunded: then a holder that stalled past its lease saved it after
// the refund was decided (the residual risk in refund()). The refund stands
// (the money goes back to the diner), and refund() tells the manager. A
// record that wasn't marked yet (its holder stopped after saving the cart, or
// the save reported an error but went through) gets its order written too.
const answerFromCart = async (id: string, caller?: Caller): Promise<Outcome | null> => {
    const { cart, payment } = await cardPaymentOf(id)
    if (!cart) return null
    const status = payment?.status ?? "completed"
    // Synced first (it never touches one being refunded), then read: a refund
    // decided before the sync stands.
    await syncRecordFromCart(cart, id, payment)
    const record = await StripeCheckoutModel.findById(id).select("state refunding").lean()
    if (record?.state === "refunded" || record?.state === "refundFailed" || record?.refunding) return null
    await markAnswered(id, outcomeKey({ state: "recorded", paymentStatus: status }), caller, { state: "recorded", paymentStatus: status })
    if (status === "failed") return { kind: "answer", ...PAYMENT_FAILED, final: "recorded" }
    return { kind: "answer", status: status === "pending" ? 202 : 200, cartId: String(cart._id), final: "recorded" }
}

// A final state's answer, for a finisher that lost the claim.
const finalAnswer = async (record: IStripeCheckout, caller?: Caller): Promise<Outcome> => {
    if (record.state === "recorded") {
        const onCart = await answerFromCart(record._id, caller)
        if (onCart) return onCart
        // Its cart was since deleted (with its shop): the money was still taken.
        await markAnswered(record._id, outcomeKey(record), caller, { state: record.state, paymentStatus: record.paymentStatus })
        if (record.paymentStatus === "failed") return { kind: "answer", ...PAYMENT_FAILED, final: "recorded" }
        return { kind: "answer", ...cartGone(record.paymentStatus === "pending"), final: "recorded" }
    }
    await markAnswered(record._id, outcomeKey(record), caller, { state: record.state })
    // Captured, and its refund failed for good: staff pay the diner back.
    if (record.state === "refundFailed") return handedOverAnswer(record._id, record.disputed)
    return { kind: "answer", status: record.status ?? NOT_COMPLETED.status, message: record.message ?? NOT_COMPLETED.message, final: record.state as FinalState }
}

// Step 3: the claim, a fresh token and lease on a record nobody holds (`open`,
// which becomes `finishing`) or whose holder's lease ran out (`releasing`
// stays `releasing`). Null when it's held, or final.
const claim = async (id: string, token: string) => {
    const fresh = { token, leaseUntil: leaseEnd() }
    return (await StripeCheckoutModel.findOneAndUpdate({ _id: id, state: "open" }, { $set: { ...fresh, state: "finishing" } }).lean()) ??
        StripeCheckoutModel.findOneAndUpdate(
            { _id: id, state: { $in: ["finishing", "releasing"] }, leaseUntil: { $lte: new Date() } },
            { $set: fresh }
        ).lean()
}

// The charge of an intent (retrieved and captured with it expanded).
const chargeOf = (intent: StripeIntent) =>
    intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge as StripeCharge : null

// Finishes intent `id`: for the diner's capture call (`caller`), or for the
// sweep or the webhook (none). `expire`: the sweep's cancel of an intent still
// unauthorised an hour after it was created. `sweep`: the sweep is finishing
// it (its diner left: it only finishes records ten minutes old, or whose
// holder stopped). `wait`: the webhook waits for another finisher as the
// route does (for an event that must act on what that finisher records).
// `leaveOpen`: nothing done to a record nobody holds (a sheet the diner may
// still be using). An error other than those handled
// below gives the claim up (or leaves it until its lease runs out, if that
// write fails too): the webhook's retry or the sweep finishes it.
export const finishStripeIntent = async (
    id: string,
    { caller, expire = false, sweep = false, wait = false, leaveOpen = false }:
        { caller?: Caller; expire?: boolean; sweep?: boolean; wait?: boolean; leaveOpen?: boolean } = {}
): Promise<Outcome> => {
    const record = await StripeCheckoutModel.findById(id).lean()
    if (leaveOpen && record?.state === "open") return { kind: "open" }
    // Step 1: the route only acts on an intent made for its cart, table and diner.
    if (caller && (!record || String(record.cartId) !== caller.cartId || record.tableId !== caller.tableId || String(record.userId) !== caller.userId)) {
        return NOT_THIS_CHECKOUT
    }
    if (!record) return { kind: "unknown" }

    const onCart = await answerFromCart(id, caller)
    if (onCart) return onCart

    // The route waits a little for another finisher; the others don't, unless told to.
    const deadline = Date.now() + (caller || wait ? stripeTiming.waitMs : 0)
    for (;;) {
        const token = randomUUID()
        const held = await claim(id, token)
        if (held) {
            try {
                return await new Holder(held, token, caller, { expire, sweep }).run()
            } catch (error) {
                if (!(error instanceof LostClaim)) {
                    // A failure after the cart saved (marking the record, say)
                    // must not tell the diner it failed: the cart is the truth.
                    const onCart = await answerFromCart(id, caller).catch(() => null)
                    if (onCart) return onCart
                    // This holder has stopped: its lease given up, so the
                    // next finisher (the webhook's retry, the sweep) takes
                    // over at once. Best effort: the lease runs out anyway.
                    await StripeCheckoutModel.updateOne({ _id: id, token }, { $set: { leaseUntil: new Date() } }).catch(() => {})
                    throw error
                }
            }
        }
        const latest = await StripeCheckoutModel.findById(id).lean()
        if (latest && FINAL_STATES.includes(latest.state)) return finalAnswer(latest, caller)
        // Charged, and waiting on a refund Stripe refused (retried later by
        // the sweep): nothing changes before then, so no waiting. The diner
        // gets the same answer they had, not "still confirming". (A refund
        // still in flight is: it may go through in a moment.)
        if (latest?.refundRetryAt && latest.refundRetryAt > new Date()) return caller ? notRefunded(id) : { kind: "waiting" }
        if (Date.now() >= deadline) return caller ? stillConfirmingFor(id) : { kind: "busy" }
        await sleep(stripeTiming.pollMs)
    }
}

// The holder of a claim: steps 4 to 8.
class Holder {
    private readonly id: string

    // `record`: as claimed, kept in step with this holder's own writes.
    constructor(
        private readonly record: IStripeCheckout,
        private readonly token: string,
        private readonly caller: Caller | undefined,
        private readonly by: { expire: boolean; sweep: boolean }
    ) {
        this.id = record._id
    }

    // A token-matched write to the record.
    // `notFinal`: only while the record isn't final (another path, the cart
    // check, may have marked it recorded meanwhile).
    private async write(set: Record<string, unknown>, unset: Record<string, 1> = {}, { notFinal = false } = {}) {
        const update = Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set }
        const filter = { _id: this.id, token: this.token, ...(notFinal ? { state: { $nin: FINAL_STATES } } : {}) }
        const { matchedCount } = await StripeCheckoutModel.updateOne(filter, update)
        if (matchedCount === 0) throw new LostClaim()
        Object.assign(this.record, set)
        for (const key of Object.keys(unset)) delete (this.record as unknown as Record<string, unknown>)[key]
    }

    // Before each call to Stripe and each cart save.
    private renew() {
        return this.write({ leaseUntil: leaseEnd() })
    }

    // The final state, and the answer given, marked as answered if the diner
    // is still there to read it. `notFinal`: see write().
    private async finish(
        state: FinalState, answer: Answer | null, set: Record<string, unknown> = {},
        { notFinal = false, unset = {} }: { notFinal?: boolean; unset?: Record<string, 1> } = {}
    ) {
        await this.write({
            state,
            finishedAt: new Date(),
            ...(answer ? { status: answer.status, message: answer.message } : {}),
            ...set,
        }, unset, { notFinal })
        const outcome = outcomeKey({ state, paymentStatus: set.paymentStatus as string | undefined })
        await markAnswered(this.id, outcome, this.caller, { state, ...(state === "recorded" ? { paymentStatus: set.paymentStatus } : {}) })
    }

    private stored(): Answer | null {
        const { status, message } = this.record
        return status && message ? { status, message } : null
    }

    // Step 4.
    async run(): Promise<Outcome> {
        await this.renew()
        const intent = await retrieveIntent(this.id)
        if (CONFIRMED_STATUSES.includes(intent.status) && !this.record.confirmed) await this.write({ confirmed: true })

        // An earlier holder decided to release it: that stands, unless the
        // capture won the race.
        if (this.record.state === "releasing") {
            return CAPTURED_STATUSES.includes(intent.status) ? this.captured(intent) : this.release(intent, this.stored() ?? NOT_COMPLETED)
        }
        switch (intent.status) {
            case "requires_capture":
                return this.checkAndCapture(intent)
            case "succeeded":
            case "processing":
                return this.captured(intent)
            case "canceled":
                // A cancel whose answer was lost, or Stripe's own after 7 days.
                await this.finish("released", this.stored() ?? NOT_COMPLETED)
                return this.answer(this.stored() ?? NOT_COMPLETED, "released")
            case "requires_action":
                // The bank check is still open: an approval can still come.
                if (!this.by.expire) return this.reopen()
                return this.release(intent, NOT_COMPLETED)
            default:
                // Declined, the bank check failed, or never confirmed. The
                // diner's sheet has given up on it by the time the route asks.
                if (this.caller || this.by.expire) return this.release(intent, NOT_COMPLETED)
                return this.reopen()
        }
    }

    // `final`: the state it ended in (none: not final yet).
    private answer(answer: Answer, final?: FinalState): Outcome {
        return { kind: "answer", ...answer, ...(final ? { final } : {}) }
    }

    // Not authorised yet: nobody holds it now.
    private async reopen(): Promise<Outcome> {
        await this.write({ state: "open" }, { token: 1, leaseUntil: 1 })
        return this.caller ? stillConfirmingFor(this.id) : { kind: "open" }
    }

    // Step 5: the checks before anything is taken, then step 6, the capture.
    private async checkAndCapture(intent: StripeIntent): Promise<Outcome> {
        const userId = new mongoose.Types.ObjectId(String(this.record.userId))
        const check = await checkoutCheck(String(this.record.cartId), this.record.tableId, userId)
        if (!check.ok) return this.release(intent, check)
        if (intent.currency !== "gbp" || intent.amount_capturable !== toPence(check.total)) return this.release(intent, AMOUNT_CHANGED)

        await this.renew()
        let captured: StripeIntent
        try {
            // Per claim: a cached error isn't replayed to the next holder.
            captured = await captureIntent(this.id, `capture:${this.id}:${this.token}`)
        } catch (error) {
            let now: StripeIntent
            try {
                now = await retrieveIntent(this.id)
            } catch {
                return this.giveUp(error)
            }
            if (CAPTURED_STATUSES.includes(now.status)) return this.captured(now)
            if (now.status === "canceled") {
                await this.finish("released", NOT_COMPLETED)
                return this.answer(NOT_COMPLETED, "released")
            }
            if (now.status === "requires_capture" && error instanceof StripeCaptureRefused) return this.release(now, CAPTURE_FAILED)
            return this.giveUp(error)
        }
        return this.captured(captured)
    }

    // The claim given up, its lease ending `until` (now: the webhook's retry,
    // the next sweep or the diner asking again takes over at once), with what
    // a later holder needs (`set`).
    private async letGo(why: string, error: unknown, { until = new Date(), set = {} }: { until?: Date; set?: Record<string, unknown> } = {}) {
        console.error(why, { paymentIntentId: this.id, error })
        await this.write({ leaseUntil: until, ...set })
    }

    // The capture's outcome is unclear.
    private async giveUp(error: unknown): Promise<Outcome> {
        await this.letGo("Stripe capture outcome unknown", error)
        return this.caller ? stillConfirmingFor(this.id) : contactStaff(this.id)
    }

    // Nothing is taken: `releasing` first, with the answer, so whoever finishes
    // it later only completes the cancel; `released` once Stripe confirms it.
    private async release(intent: StripeIntent, answer: Answer): Promise<Outcome> {
        if (this.record.state !== "releasing") {
            await this.write({ state: "releasing", status: answer.status, message: answer.message })
        }
        if (intent.status !== "canceled") {
            await this.renew()
            try {
                await cancelIntent(this.id)
            } catch (error) {
                const now = await retrieveIntent(this.id).catch(() => null)
                if (now && CAPTURED_STATUSES.includes(now.status)) return this.captured(now)
                if (now?.status !== "canceled") {
                    // Left `releasing`: whoever finishes it only completes the
                    // cancel, so nothing can be taken, and the diner gets the
                    // release's answer. Given up at once, so the next finisher
                    // (the diner asking again, the webhook's retry, the sweep)
                    // completes the cancel. The webhook retries (500).
                    // Its outcome will be `released` (unless the capture won,
                    // which is then a new outcome, and told).
                    await this.letGo("Stripe cancel failed", error)
                    await markAnswered(this.id, outcomeKey({ state: "released" }), this.caller, { state: { $in: ["releasing", "released"] } })
                    return this.caller ? this.answer(this.stored() ?? answer) : contactStaff(this.id)
                }
            }
        }
        await this.finish("released", answer)
        return this.answer(answer, "released")
    }

    // Step 7: captured, not on a cart.
    private async captured(intent: StripeIntent): Promise<Outcome> {
        const charge = chargeOf(intent)
        // An earlier holder decided to refund it, or started to: finish that,
        // never settle. A decided refund stands even if a cart has it (a
        // holder that stalled past its lease saved it: refund() tells the
        // manager). Refunded money without that decision is checked against
        // the carts first: a manager may have refunded part of a recorded
        // payment. The answer says it was refunded (a stored release answer,
        // "nothing was charged", would be wrong now).
        if (this.record.refunding || (charge && charge.amount_refunded > 0)) {
            if (!this.record.refunding) {
                const onCart = await answerFromCart(this.id, this.caller)
                if (onCart) return onCart
            }
            const stored = this.stored()
            return this.refund(stored?.message === NOT_RECORDED.message ? NOT_RECORDED : CART_CHANGED)
        }

        const pending = intent.status === "processing"
        const settlement: Settlement = {
            provider: "stripe",
            checkoutId: this.id,
            paymentId: chargeIdOf(intent),
            status: pending ? "pending" : "completed",
            // Verified against the amount due (amount_received is 0 while processing).
            amount: intent.amount / 100,
            currency: intent.currency.toUpperCase(),
        }
        const { cartId, tableId } = this.record
        let outcome: SettleOutcome
        try {
            outcome = await settleCheckout(String(cartId), tableId, new mongoose.Types.ObjectId(String(this.record.userId)), settlement, {
                beforeSave: async () => {
                    try {
                        await this.renew()
                        return true
                    } catch (error) {
                        if (error instanceof LostClaim) return false
                        throw error
                    }
                },
                // Finished by the sweep for a diner who had left: the manager
                // sees who did it. (Not the webhook's: Stripe's notice often
                // comes while the diner's own capture call is on its way.)
                change: this.by.sweep ? (cart) => log(cart, undefined, "stripeFinished",
                    `${money(settlement.amount, "GBP")} card payment finished by the server after the diner left (payment ${this.id})`) : undefined,
            })
        } catch (error) {
            // Most likely brief (a database failover): the claim is given up
            // so the next finisher settles it. One still failing an hour after
            // its first failure is refunded, so a payment can't stay taken and
            // unrecorded.
            // It may have saved after all (an error reported after the write).
            const onCart = await answerFromCart(this.id, this.caller).catch(() => null)
            // (Its record is recorded now: final, so no lease to give up.)
            if (onCart) return onCart
            const since = this.record.settleFailingSince ?? new Date()
            if (since.getTime() > Date.now() - SETTLE_RETRY_MS) {
                await this.letGo("Settling a captured Stripe payment failed: the next finisher retries", error, { set: { settleFailingSince: since } })
                return this.caller ? stillConfirmingFor(this.id) : contactStaff(this.id)
            }
            console.error("Settling a captured Stripe payment keeps failing: refunding it", { paymentIntentId: this.id, error })
            outcome = { ok: false, ...NOT_RECORDED, status: 500 }
        }
        if (!outcome.ok && outcome.lost) throw new LostClaim()
        if (outcome.ok) {
            // Recorded: its order now, a failure only logged (never refunded).
            await keepOrderInStep(outcome.cart, outcome.cart.payments.at(-1)!._id)
            try {
                // Not over a record the cart check marked recorded meanwhile
                // (a manager's check may have moved its status on since).
                await this.finish("recorded", null, { paymentStatus: settlement.status }, { notFinal: true })
            } catch (error) {
                if (!(error instanceof LostClaim)) throw error
                const onCart = await answerFromCart(this.id, this.caller)
                if (onCart) return onCart
                throw error
            }
            return { kind: "answer", status: pending ? 202 : 200, cartId: String(cartId), final: "recorded" }
        }

        // Step 8: settling is impossible. The cart is the truth: a replay of
        // this same intent, saved by another finisher, is recorded.
        const onCart = await answerFromCart(this.id, this.caller)
        if (onCart) return onCart
        return this.refund(outcome.status === 500 ? NOT_RECORDED : CART_CHANGED)
    }

    // A full refund (of what's left) of a captured intent that can't be
    // recorded, under this claim's key.
    private async refund(answer: Answer): Promise<Outcome> {
        // Decided: a later holder only completes the refund (never settles),
        // with this answer.
        // Only on a record not yet final: one the cart check marked recorded
        // meanwhile is recorded (this holder backs off, and answers from it).
        await this.write(
            { refunding: true, status: answer.status, message: answer.message, leaseUntil: leaseEnd() },
            { refundRetryAt: 1, refundId: 1 },
            { notFinal: true }
        )
        let made: { id: string } | null = null
        try {
            made = await createRefund(
                { payment_intent: this.id, metadata: { intentId: this.id, cartId: String(this.record.cartId), late: "true" } },
                `late-refund:${this.id}:${this.token}`
            )
        } catch (error) {
            // Refused as already refunded: an earlier holder's refund, or one
            // staff made by hand, went through.
            if (!(error instanceof StripeRefundRefused && error.code === "charge_already_refunded")) {
                // Unclear: tried again at once.
                if (!(error instanceof StripeRefundRefused)) {
                    await this.letGo("Stripe refund failed after capture", error, { set: { refundRetryAt: new Date() } })
                    return notRefunded(this.id)
                }
                // Refused (or made and failed): for a reason that won't clear,
                // or for a day, handed to staff; else tried again in half an
                // hour, so a refund Stripe won't make isn't asked for every
                // two minutes. Reported by the sweep at two hours.
                const since = this.record.refundRefusedSince ?? new Date()
                if (wontClear(error.code)) return this.handOver(error.code!, error)
                if (since.getTime() <= Date.now() - REFUSED_FOR_MS) return this.handOver(`refused for a day: ${error.code ?? error.message}`, error)
                const until = new Date(Date.now() + REFUND_RETRY_MS)
                await this.letGo("Stripe refund failed after capture", error, { until, set: { refundRetryAt: until, refundRefusedSince: since } })
                return notRefunded(this.id)
            }
        }
        // The refund that did it, if this holder made it (a failure Stripe
        // reports later reopens the record: reopenFailedRefund). One reopened
        // that way keeps its first finishedAt: the same outcome, so the same
        // notice (one the diner dismissed stays dismissed).
        await this.finish("refunded", answer, {
            ...(made ? { refundId: made.id } : {}),
            ...(this.record.finishedAt ? { finishedAt: this.record.finishedAt } : {}),
        }, { unset: { refundRefusedSince: 1 } })
        // Accepted residual risk: a holder that stalled past its lease between
        // renewing and saving the cart. Seen, so the manager knows. Best
        // effort: the refund is done whatever happens here.
        try {
            const cart = await CartModel.findOne({ stripePaymentIntentIds: this.id }).select("_id")
            if (cart) {
                const details = `recorded, but refunded by Stripe after a lost race: the diner wasn't charged (payment ${this.id})`
                console.error(`A card payment was ${details}`, { cartId: String(cart._id) })
                // Once, however often it's refunded again (reopenFailedRefund).
                await logOnce(cart._id, "stripeRefundedRecorded", details)
            }
        } catch (error) {
            console.error("A refunded card payment's cart couldn't be checked or logged", { paymentIntentId: this.id, error })
        }
        return this.answer(answer, "refunded")
    }

    // A refund Stripe won't make: handed to staff, as reopenFailedRefund hands
    // one over. Final first, so nothing refunds it again; staff told then
    // (if that fails, by the sweep).
    private async handOver(why: string, error: unknown): Promise<Outcome> {
        console.error("A card payment's refund after a lost race was refused by Stripe: handed to staff", { paymentIntentId: this.id, why, error })
        // What's still taken. Stripe not answering: the next holder tries
        // again (the error gives this claim up). Refunded in full by hand
        // meanwhile (Stripe refusing it for another reason): refunded.
        await this.renew()
        const owed = await stillTaken(this.id)
        if (owed !== null && owed <= 0) {
            const answer = this.stored() ?? NOT_RECORDED
            await this.finish("refunded", answer, {
                ...(this.record.finishedAt ? { finishedAt: this.record.finishedAt } : {}),
            }, { unset: { refundRefusedSince: 1 } })
            return this.answer(answer, "refunded")
        }
        await this.finish("refundFailed", null, handedOverFields(owed, why))
        await tellStaff(this.id).catch((tellError) => console.error("Staff couldn't be told yet of a card payment Stripe won't refund: the sweep retries", {
            paymentIntentId: this.id, error: tellError,
        }))
        return handedOverAnswer(this.id, this.record.disputed)
    }
}

// A payment handed to staff (`refundFailed`) not told yet: told on the
// table's cart (the one it was made for; a closed one is listed again for a
// day, as the line changes it), with the diner's first name and the payment
// id to find it in Stripe's dashboard, then marked told (`staffToldAt`). In
// words true however it got here: a holder that stalled past its lease may
// have recorded it on a cart after its refund was decided (refund() told staff
// then the diner wasn't charged, so they may have paid again), so staff
// check before paying back. Its cart gone (deleted with its table or shop):
// a server error only. One not told (an error) is told by the sweep.
export const tellStaff = async (id: string) => {
    const record = await StripeCheckoutModel.findOne({ _id: id, state: "refundFailed", staffToldAt: { $exists: false } })
        .select("cartId tableId userId amount refundOwed disputed").lean()
    if (!record) return
    const { cartId } = record
    // The pay-back first (S35): what's shown and marked done. Written whether
    // or not the cart is still there; once, however often this runs. For the
    // shop that has its table now: the record's may have been deleted since
    // (a refund failing more than 30 days on), and nothing would show it.
    const shopId = await shopIdOfTable(record.tableId)
    if (shopId) {
        await writePayback({
            kind: "refundRefused", shopId, tableId: record.tableId, cartId, userId: record.userId,
            amount: (record.refundOwed ?? record.amount) / 100, currency: "GBP", paymentIntentId: id,
            ...(record.disputed && { disputed: true }),
        })
    } else {
        console.error("A card payment Stripe won't refund has no shop left to show its pay-back on: pay the diner back from Stripe's dashboard", {
            paymentIntentId: id, tableId: record.tableId,
        })
    }
    const diner = dinerName(await UserModel.findById(record.userId).select("name").lean())
    const amount = money((record.refundOwed ?? record.amount) / 100, "GBP")
    const details = record.disputed
        ? `${amount} card payment by ${diner} is disputed with their bank, so Stripe won't refund it (payment ${id}). ` +
            "Don't pay them back yourselves: accept the dispute in Stripe's dashboard (don't contest it), and their bank returns the money. " +
            "If it closes without the money going back to them, pay them back another way."
        : `${amount} card payment by ${diner}: Stripe won't refund it, so they were charged (payment ${id}). ` +
            "Pay them back another way, unless a cart shows this payment as paid and they didn't pay again, " +
            "or Stripe's dashboard shows they've disputed it since (their bank returns it then)."
    const { matchedCount } = await logOnce(cartId, "stripeRefundFailed", details)
    if (matchedCount === 0 && !(await CartModel.exists({ _id: cartId }))) {
        console.error("A card payment Stripe won't refund has no cart left to tell staff on: pay the diner back from Stripe's dashboard", {
            paymentIntentId: id, cartId: String(cartId),
        })
    }
    await StripeCheckoutModel.updateOne({ _id: id }, { $set: { staffToldAt: new Date() } })
}

// A late refund (refund() above) that Stripe accepted, then couldn't make (the
// webhook's refund.failed, S34), for Stripe's `reason`: the money is still
// taken.
// - "reopened": one that may go through next time, made fewer than
//   REFUND_REOPENS times again: the record goes back to being refunded.
//   `finishing` with `refunding`, its lease ending when one Stripe refused
//   would be retried, so the sweep refunds it again then. The diner was told
//   it was refunded; that stands.
// - "handedOver": one that won't (FOR_GOOD), or kept failing: `refundFailed`,
//   final, so nothing retries it; staff are told, and the diner
//   gets a notice (a new outcome, finished now) to ask staff for it. Staff
//   are told here (tellStaff; an error, answered 500, is retried by Stripe
//   and the sweep). Also for one already handed over (a repeated event).
// - "inFlight": a holder is still making its refund (refund() unsets the
//   retry time; one waiting to retry, or reopened, has one), so the record
//   may say refunded in a moment: the webhook has Stripe retry. Looked at
//   first: a record can only go from in flight to refunded, which the updates
//   then find.
// - "none": not the refund that finished it (it acts only for that one, or for
//   any when it isn't known: its holder stopped before finishing, and the next
//   found the charge already refunded), or the charge is refunded in full at
//   Stripe now (a stale event: staff refunded it by hand, say, so it's never
//   handed over to be paid back twice). A repeated event, or an older
//   refund's, changes nothing.
export const reopenFailedRefund = async (
    id: string, refundId: string, reason: string | null
): Promise<"reopened" | "handedOver" | "inFlight" | "none"> => {
    if (await StripeCheckoutModel.exists({ _id: id, refunding: true, state: { $nin: FINAL_STATES }, refundRetryAt: { $exists: false } })) {
        return "inFlight"
    }
    // The refund that finished it, or any when that isn't known.
    const ofRefund = { _id: id, $or: [{ refundId }, { refundId: { $exists: false } }] }
    const record = await StripeCheckoutModel.findOne({ ...ofRefund, state: { $in: ["refunded", "refundFailed"] } }).select("state").lean()
    if (!record) return "none"
    // Already handed over (a repeat): staff told, if they weren't.
    if (record.state === "refundFailed") {
        await tellStaff(id)
        return "handedOver"
    }
    const owed = await stillTaken(id, refundId)
    if (owed !== null && owed <= 0) return "none"
    const refunded = { ...ofRefund, state: "refunded" as const }
    if (!wontClear(reason)) {
        const until = new Date(Date.now() + REFUND_RETRY_MS)
        const { modifiedCount } = await StripeCheckoutModel.updateOne(
            { ...refunded, refundFailures: { $not: { $gte: REFUND_REOPENS } } },
            {
                $set: { state: "finishing", refunding: true, leaseUntil: until, refundRetryAt: until },
                $unset: { token: 1, refundId: 1 },
                $inc: { refundFailures: 1 },
            }
        )
        if (modifiedCount > 0) return "reopened"
    }
    const { modifiedCount } = await StripeCheckoutModel.updateOne(refunded, {
        $set: { state: "refundFailed", finishedAt: new Date(), ...handedOverFields(owed, reason) },
        $inc: { refundFailures: 1 },
    })
    // Changed meanwhile (another delivery handed it over: told below, once).
    if (modifiedCount === 0 && !await StripeCheckoutModel.exists({ ...ofRefund, state: "refundFailed" })) return "none"
    await tellStaff(id)
    return "handedOver"
}

// --------------------------------------------------------------------------
// The sweep: a backstop for whatever the webhook missed (a crash or an error
// after a capture, deliveries that all failed). Run every 2 minutes by the
// server (index.ts), and by src/scripts/finishStripeCheckouts.ts. Every age is
// from `createdAt` (`updatedAt` moves each time a record goes back to open).

const MINUTE = 60 * 1000
const LOOK_EVERY_MS = 10 * MINUTE
const CANCEL_AFTER_MS = 60 * MINUTE
const UNFINISHED_AFTER_MS = 120 * MINUTE
// An intent that needs finishing, as the sweep finds it (the others are a
// sheet still in use, left alone until the hour).
const NEEDS_FINISHING = ["requires_capture", "succeeded", "processing", "canceled"]

type Counts = { finished: number; released: number; refunded: number; handedOver: number; left: number; failed: number }

// By the state it ended in; anything not final is left for a later finisher
// (a failure throws).
const tally = (counts: Counts, outcome: Outcome) => {
    const final = outcome.kind === "answer" ? outcome.final : undefined
    if (final === "recorded") counts.finished++
    else if (final === "released") counts.released++
    else if (final === "refunded") counts.refunded++
    else if (final === "refundFailed") counts.handedOver++
    else counts.left++
}

const sweep = async (): Promise<Counts> => {
    const counts: Counts = { finished: 0, released: 0, refunded: 0, handedOver: 0, left: 0, failed: 0 }
    const now = Date.now()
    const finish = async (id: string, expire = false) => {
        try {
            tally(counts, await finishStripeIntent(id, { expire, sweep: true }))
        } catch (error) {
            counts.failed++
            console.error("The sweep couldn't finish a card payment", { paymentIntentId: id, error })
        }
    }

    // Claims whose holder stopped.
    const stopped = await StripeCheckoutModel.find({ state: { $in: ["finishing", "releasing"] }, leaseUntil: { $lte: new Date(now) } }).select("_id").lean()
    for (const { _id } of stopped) await finish(_id)

    // Unclaimed ones: looked at (without claiming, so a sheet still in use is
    // never claimed from under the diner), and finished if they need it.
    const lookedAt = new Date(now - LOOK_EVERY_MS)
    const open = await StripeCheckoutModel.find({
        state: "open",
        createdAt: { $lte: lookedAt },
        $or: [{ checkedAt: { $exists: false } }, { checkedAt: { $lte: lookedAt } }],
    }).select("_id createdAt").lean()
    for (const { _id, createdAt } of open) {
        try {
            const intent = await retrieveIntent(_id)
            await StripeCheckoutModel.updateOne({ _id, state: "open" }, { $set: { checkedAt: new Date() } })
            const abandoned = createdAt.getTime() <= now - CANCEL_AFTER_MS
            if (NEEDS_FINISHING.includes(intent.status) || abandoned) await finish(_id, abandoned)
        } catch (error) {
            counts.failed++
            console.error("The sweep couldn't look at a card payment", { paymentIntentId: _id, error })
        }
    }

    // Handed to staff, who weren't told (an error then).
    const untold = await StripeCheckoutModel.find({ state: "refundFailed", staffToldAt: { $exists: false } }).select("_id").lean()
    for (const { _id } of untold) {
        try {
            await tellStaff(_id)
        } catch (error) {
            counts.failed++
            console.error("The sweep couldn't tell staff of a card payment Stripe won't refund", { paymentIntentId: _id, error })
        }
    }

    // Seen, so someone looks into it: once each (the sweep keeps trying it).
    const unfinished = await StripeCheckoutModel.find({
        state: { $in: ["open", "finishing", "releasing"] },
        createdAt: { $lte: new Date(now - UNFINISHED_AFTER_MS) },
        reportedAt: { $exists: false },
    }).select("_id state").lean()
    for (const { _id, state } of unfinished) {
        console.error("A card payment is still unfinished two hours after it started", { paymentIntentId: _id, state })
        await StripeCheckoutModel.updateOne({ _id }, { $set: { reportedAt: new Date() } })
    }
    return counts
}

// One run at a time: a Stripe outage can make one long. Null when skipped.
let sweeping = false
export const sweepStripeCheckouts = async (): Promise<Counts | null> => {
    if (sweeping) return null
    sweeping = true
    try {
        return await sweep()
    } finally {
        sweeping = false
    }
}
