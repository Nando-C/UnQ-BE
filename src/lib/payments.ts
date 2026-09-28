// Provider-neutral money operations on a recorded payment (see the cart's
// `payments`). Routes call these, never a provider's client directly, so adding
// a provider (e.g. Stripe) means adding its branch here, not touching a route.

import { IPayment, PaymentStatus } from "src/typings/cart"
import { findRefund, getOrder, PayPalRefundRefused, refundCapture } from "./paypal"

// The provider's name as people know it, for messages.
export const providerName = (payment: IPayment) =>
    ({ paypal: "PayPal" } as Record<string, string>)[payment.provider] ?? payment.provider

// The provider refused the refund, or it was never sent: nothing was refunded.
// Any other error from refundPayment leaves the outcome unknown.
export class RefundRefused extends Error {}

// Refunds `amount` (in the payment's currency) of a payment. `requestId` must be
// unique to this refund and stable across retries: the provider uses it so the
// same refund can't happen twice. Throws RefundRefused when nothing was refunded.
export const refundPayment = async (
    payment: IPayment,
    amount: number,
    requestId: string
): Promise<{ providerRefundId?: string }> => {
    if (!payment.providerPaymentId) {
        throw new RefundRefused(`This payment can only be refunded from ${providerName(payment)}`)
    }
    switch (payment.provider) {
        case "paypal":
            try {
                return {
                    providerRefundId: await refundCapture(payment.providerPaymentId, {
                        value: amount.toFixed(2),
                        currency: payment.currency,
                        requestId,
                    }),
                }
            } catch (error) {
                throw error instanceof PayPalRefundRefused ? new RefundRefused(error.message) : error
            }
        default:
            throw new RefundRefused(`Refunds aren't supported for ${providerName(payment)}`)
    }
}

// Whether the provider already has the refund sent under `requestId` (see
// refundPayment): null if not, else its id and whether it failed there. Throws
// if the provider can't be asked.
export const findProviderRefund = async (
    payment: IPayment,
    requestId: string
): Promise<{ providerRefundId?: string; failed: boolean } | null> => {
    switch (payment.provider) {
        case "paypal": {
            const refund = await findRefund(payment.providerCheckoutId, requestId)
            return refund
                ? { providerRefundId: refund.id, failed: refund.status === "FAILED" || refund.status === "CANCELLED" }
                : null
        }
        default:
            throw new Error(`Refunds aren't supported for ${providerName(payment)}`)
    }
}

// Where the provider says a payment it hasn't confirmed yet stands: `completed`
// (the money is ours; a refund since doesn't change that), `failed` (nothing
// was taken), or still `pending`. Throws if the provider can't be asked.
export const checkProviderPayment = async (payment: IPayment): Promise<PaymentStatus> => {
    switch (payment.provider) {
        case "paypal": {
            const order = await getOrder(payment.providerCheckoutId)
            const captures = (order.purchase_units ?? []).flatMap((u) => u.payments?.captures ?? [])
            const capture = captures.find((c) => c.id === payment.providerPaymentId)
            if (!capture) throw new Error("PayPal has no record of this payment's capture")
            switch (capture.status) {
                case "COMPLETED":
                case "PARTIALLY_REFUNDED":
                case "REFUNDED":
                    return "completed"
                case "DECLINED":
                case "FAILED":
                    return "failed"
                default:
                    return "pending"
            }
        }
        default:
            throw new Error(`Payments can't be checked for ${providerName(payment)}`)
    }
}
