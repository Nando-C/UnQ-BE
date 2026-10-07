// The Stripe calls UnQ makes, through the official client: card PaymentIntents
// with manual capture (create, retrieve, capture, cancel), and refunds (create,
// list). The secret key comes from the environment and is never logged. Routes
// go through lib/payments.ts for refunds and payment checks, and through
// services/carts/stripeFinish.ts for checkout.

import Stripe from "stripe"
import env from "../settings/env"

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    // Pinned, so the shapes read here change only when this does.
    apiVersion: "2026-09-30.endive",
    timeout: 20_000,
    maxNetworkRetries: 1,
})

export type StripeIntent = Stripe.PaymentIntent
export type StripeCharge = Stripe.Charge
export type StripeRefund = Stripe.Refund

// Whether Stripe answered and did nothing: a card error, or an invalid request
// other than a 409 (an earlier request with the same idempotency key is still
// running) or a 429 (rate limited). Anything else (a connection error, a 5xx)
// leaves the outcome unknown.
const refused = (error: unknown) =>
    error instanceof Stripe.errors.StripeCardError ||
    (error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode !== 409 && error.statusCode !== 429)

// Stripe refused the capture: nothing was taken by this call. The caller
// retrieves the intent to see where it stands (it may have been captured
// earlier).
export class StripeCaptureRefused extends Error {}

// Stripe refused the refund: nothing was refunded by this call. `code` is
// Stripe's (e.g. charge_already_refunded).
export class StripeRefundRefused extends Error {
    constructor(message: string, readonly code?: string) {
        super(message)
    }
}

// A PaymentIntent for `amount` pence, cards only, authorised by the diner and
// captured by the server (manual capture).
export const createIntent = (amount: number, metadata: Record<string, string>) =>
    stripe.paymentIntents.create({
        amount,
        currency: "gbp",
        capture_method: "manual",
        // Cards (Apple Pay and Google Pay are cards too) settle at once; no
        // bank debits or pay-later methods, which settle days later.
        allowed_payment_method_types: ["card"],
        metadata,
    })

// The id of an intent's latest charge (what refunds go against), expanded or not.
export const chargeIdOf = (intent: StripeIntent) =>
    typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id

// The intent with its latest charge (the charge id and what's refunded of it).
export const retrieveIntent = (id: string) => stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] })

// Captures an authorised intent, under `idempotencyKey`. Throws
// StripeCaptureRefused when Stripe refused it; anything else it throws leaves
// the outcome unknown.
export const captureIntent = async (id: string, idempotencyKey: string) => {
    try {
        return await stripe.paymentIntents.capture(id, { expand: ["latest_charge"] }, { idempotencyKey })
    } catch (error) {
        throw refused(error) ? new StripeCaptureRefused((error as Error).message) : error
    }
}

// Cancels an intent that isn't captured: an authorisation's hold is released.
export const cancelIntent = (id: string) => stripe.paymentIntents.cancel(id)

// Refunds a charge or an intent: `amount` pence, or all that's left without
// one. Stripe answers a repeated `idempotencyKey` with the original result (for
// 24 hours). Throws StripeRefundRefused when Stripe refused it, or made it and
// it failed (code: its failure reason); anything else it throws leaves the
// outcome unknown. One accepted (pending or succeeded) is on its way.
export const createRefund = async (
    params: { charge?: string; payment_intent?: string; amount?: number; metadata: Record<string, string> },
    idempotencyKey: string
) => {
    let refund
    try {
        refund = await stripe.refunds.create(params, { idempotencyKey })
    } catch (error) {
        if (!refused(error)) throw error
        throw new StripeRefundRefused((error as Error).message, (error as { code?: string }).code)
    }
    if (refund.status === "failed" || refund.status === "canceled") {
        const reason = refund.failure_reason ?? refund.status
        throw new StripeRefundRefused(`Stripe didn't make the refund (${reason})`, reason)
    }
    return refund
}

// Every refund of an intent, through all pages (a page holds at most 100).
export const listRefunds = (paymentIntent: string) =>
    stripe.refunds.list({ payment_intent: paymentIntent, limit: 100 }).autoPagingToArray({ limit: 10_000 })
