// Provider-neutral money operations on a recorded payment (see the cart's
// `payments`). Routes call these, never a provider's client directly, so adding
// a provider (e.g. Stripe) means adding its branch here, not touching a route.

import { IPayment } from "src/typings/cart"
import { refundCapture } from "./paypal"

// The provider's name as people know it, for messages.
export const providerName = (payment: IPayment) =>
    ({ paypal: "PayPal" } as Record<string, string>)[payment.provider] ?? payment.provider

// Refunds `amount` (in the payment's currency) of a payment. `requestId` must be
// unique to this refund and stable across retries: the provider uses it so the
// same refund can't happen twice. Throws with the provider's reason on failure.
export const refundPayment = async (
    payment: IPayment,
    amount: number,
    requestId: string
): Promise<{ providerRefundId?: string }> => {
    if (!payment.providerPaymentId) {
        throw new Error(`This payment can only be refunded from ${providerName(payment)}`)
    }
    switch (payment.provider) {
        case "paypal":
            return {
                providerRefundId: await refundCapture(payment.providerPaymentId, {
                    value: amount.toFixed(2),
                    currency: payment.currency,
                    requestId,
                }),
            }
        default:
            throw new Error(`Refunds aren't supported for ${providerName(payment)}`)
    }
}
