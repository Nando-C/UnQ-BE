// Stripe's webhook events, trusted only by their signature (no sign-in). Its
// own module, apart from lib/stripe.ts: the suites that replace lib/stripe.ts
// with a fake keep this check real.

import Stripe from "stripe"
import env from "../settings/env"

export type StripeEvent = Stripe.Event

// Where Stripe posts its events (server.ts keeps the raw body for this path).
export const STRIPE_WEBHOOK_PATH = "/payments/stripe/webhook"

// Whether a request's URL is the webhook's, as Express matches routes: any
// case, a trailing slash or not, a full URL (a proxy may forward one) or a
// path. Run for every JSON body: most are ruled out by the cheap first test.
export const isStripeWebhook = (url = "") => {
    if (!url.toLowerCase().includes(STRIPE_WEBHOOK_PATH)) return false
    try {
        return new URL(url, "http://localhost").pathname.toLowerCase().replace(/\/+$/, "") === STRIPE_WEBHOOK_PATH
    } catch {
        return false
    }
}

// The event in `rawBody` (the bytes as received: a re-serialised body wouldn't
// verify), if `signature` (the Stripe-Signature header) is Stripe's for it
// under the endpoint's signing secret and recent. Null otherwise.
export const verifiedEvent = (rawBody: Buffer | undefined, signature: string | string[] | undefined): StripeEvent | null => {
    if (!rawBody || typeof signature !== "string") return null
    try {
        return Stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET)
    } catch (error) {
        if (error instanceof Stripe.errors.StripeSignatureVerificationError) return null
        throw error
    }
}
