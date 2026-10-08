import createError from "http-errors"
import { TController } from "src/typings/controllers"
import { StripeEvent, verifiedEvent } from "../../lib/stripeWebhook"
import type { StripeIntent, StripeRefund } from "../../lib/stripe"
import { idOf } from "../../lib/stripe"
import { fromPence, money } from "../../lib/money"
import { cardPaymentOf, finishStripeIntent, Outcome, reopenFailedRefund } from "../carts/stripeFinish"
import { checkPendingPayment, managerRefundFailed } from "../carts/managerControllers"

// POST /payments/stripe/webhook: Stripe's events about the card payments UnQ
// made. Stripe retries one not answered 2xx, for up to 3 days, and may repeat
// or reorder them, so every handler is idempotent and acts on the state it
// finds (an intent as Stripe reports it now), not the event's copy. A 500 asks
// for the retry; the sweep (stripeFinish.ts) is the backstop either way.
// Intents and refunds UnQ didn't make are answered 200 and left alone.

type Handled = "done" | "retry"

// The finishing procedure's outcome. Final (even a 500 one: a refund handed
// to staff), left to a holder with a live lease (it finishes it; the sweep if
// it stops), or not authorised yet: done. Its own unclear capture, a refund
// that failed, a cancel or a save that failed (a 500 answer): retried.
const finished = (outcome: Outcome): Handled =>
    (outcome.kind === "answer" && !outcome.final && outcome.status >= 500 ? "retry" : "done")

// A recorded payment: its record synced, and a pending one settled. Null if
// no cart has it.
const settleOnCart = async (id: string): Promise<Handled | null> => {
    const { cart, payment } = await cardPaymentOf(id)
    if (!cart || !payment) return null
    const check = await checkPendingPayment(cart, payment, undefined)
    switch (check.kind) {
        case "unreachable":
            console.error("Stripe webhook: couldn't check a pending card payment", { paymentIntentId: id, error: check.error })
            return "retry"
        case "lost":
            console.error("Stripe webhook: a pending card payment couldn't be saved (its cart kept changing, or is gone)", {
                paymentIntentId: id, cartId: String(cart._id),
            })
            return "retry"
        default:
            // Its record not synced (logged): retried, as nothing else would.
            return check.synced ? "done" : "retry"
    }
}

const onIntent = async (type: StripeEvent["type"], intent: StripeIntent): Promise<Handled> => {
    // Authorised: finished for the diner, who may never come back for it.
    // Another finisher on it (the diner's own request) finishes it; one waiting
    // to retry a refund is the sweep's.
    if (type === "payment_intent.amount_capturable_updated") return finished(await finishStripeIntent(intent.id))

    const onCart = await settleOnCart(intent.id)
    if (onCart) return onCart
    // Not on a cart: finished (captured: a second chance after a crash;
    // cancelled: a release completed). Another finisher on it may record it
    // pending, which this event settles: waited for as the diner's request
    // waits, then settled; still held after that, retried. A card declined in
    // the diner's sheet (they may try another) is left alone while nobody
    // holds it, as the sweep leaves a sheet in use.
    const outcome = await finishStripeIntent(intent.id, { wait: true, leaveOpen: type === "payment_intent.payment_failed" })
    if (outcome.kind === "unknown" || outcome.kind === "open" || outcome.kind === "waiting") return "done"
    if (outcome.kind === "busy" || finished(outcome) === "retry") return "retry"
    return (await settleOnCart(intent.id)) ?? "done"
}

// A refund Stripe accepted, then couldn't make (the diner's card closed;
// rare). Not reversed (decided 2026-10-07): staff pay the diner another way.
const onRefundFailed = async (refund: StripeRefund): Promise<Handled> => {
    const intentId = idOf(refund.payment_intent)
    const { cartId, requestId, late } = refund.metadata ?? {}
    const reason = refund.failure_reason ?? "no reason given"
    const amount = money(fromPence(refund.amount), refund.currency.toUpperCase())

    // The full refund of a payment that couldn't be recorded: the money is
    // still taken, so it's refunded again, or handed to staff when it won't go
    // through (stripeFinish.ts).
    if (late === "true") {
        const reopened = intentId ? await reopenFailedRefund(intentId, refund.id, refund.failure_reason ?? null) : "none"
        // "none": not its refund, or nothing's still taken (refunded since).
        console.error(reopened === "none"
            ? "A card payment's refund after a lost race failed at Stripe, but it changes nothing now (an older refund's, or refunded since)"
            : "A card payment's refund after a lost race failed at Stripe: the money is still taken", {
            paymentIntentId: intentId, cartId, refundId: refund.id, reason, reopened,
        })
        // A finisher still making it: retried, so a later delivery reopens it.
        return reopened === "inFlight" ? "retry" : "done"
    }

    // A manager's refund, by its entry on the cart (managerControllers.ts).
    if (cartId && requestId) {
        const what = `${amount} refund failed at Stripe (${reason}; refund ${requestId}, Stripe's ${refund.id})`
        return managerRefundFailed(cartId, requestId, what, { intentId, failureReason: refund.failure_reason })
    }

    // Made in Stripe's dashboard (no metadata): seen, nothing to update.
    console.error("A card refund made outside UnQ failed at Stripe", { paymentIntentId: intentId, refundId: refund.id, amount, reason })
    return "done"
}

const handle = async (event: StripeEvent): Promise<Handled> => {
    switch (event.type) {
        case "payment_intent.amount_capturable_updated":
        case "payment_intent.succeeded":
        case "payment_intent.payment_failed":
        case "payment_intent.canceled":
            return onIntent(event.type, event.data.object)
        case "refund.failed":
            return onRefundFailed(event.data.object)
        default:
            return "done"
    }
}

export const stripeWebhook: TController = async (req, res, next) => {
    try {
        const event = verifiedEvent(req.rawBody, req.headers["stripe-signature"])
        if (!event) return next(createError(400, "Invalid Stripe signature"))
        if ((await handle(event)) === "retry") {
            // Exposed (Stripe's dashboard shows it), so logged here.
            console.error("Stripe webhook: event not handled yet, Stripe retries it", { eventId: event.id, type: event.type })
            return next(createError(500, `Stripe event ${event.id} not handled yet: retry it`, { expose: true }))
        }
        res.send({ received: true })
    } catch (error) {
        // Logged by the error handler; Stripe retries.
        next(createError(500, error as Error))
    }
}
