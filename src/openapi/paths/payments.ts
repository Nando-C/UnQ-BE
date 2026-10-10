import { Paths, PUBLIC, error, json, ref } from "../helpers"

// services/payments/routes.ts, stripeWebhook.ts; lib/stripeWebhook.ts.

export const paymentPaths: Paths = {
    "/payments/stripe/webhook": {
        post: {
            operationId: "stripeWebhook", tags: ["Payments"], security: PUBLIC,
            summary: "Stripe's events",
            description: "Called by Stripe, not by clients: trusted by the `Stripe-Signature` header over the body's exact bytes (the signing secret is `STRIPE_WEBHOOK_SECRET`). The endpoint subscribes to `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled` and `refund.failed`; other types are answered 200 and ignored. Handlers are idempotent and act on the state they find, since Stripe may repeat or reorder events. A 500 asks Stripe to retry (for up to 3 days); the server's 2-minute sweep is the backstop either way.",
            parameters: [{ name: "Stripe-Signature", in: "header", required: true, schema: { type: "string" } }],
            requestBody: { required: true, content: { "application/json": { schema: { type: "object", description: "A Stripe Event" } } } },
            responses: {
                200: json("Handled (or not one of ours)", ref("Received")),
                400: error('"Invalid Stripe signature": no raw body, no header, or a signature that doesn\'t verify'),
                500: error('"Stripe event … not handled yet: retry it"; or "Generic Server Error" (Stripe retries both)'),
            },
        },
    },
}
