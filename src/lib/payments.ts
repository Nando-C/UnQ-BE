// Provider-neutral money operations on a recorded payment (see the cart's
// `payments`). Routes call these, never a provider's client directly, so adding
// a provider means adding its branch here, not touching a route.

import { ICart, IPayment, PaymentStatus } from "src/typings/cart"
import { findRefund, getOrder, PayPalRefundRefused, refundCapture } from "./paypal"
import { cancelIntent, chargeIdOf, createRefund, listRefunds, refundUndone, retrieveIntent, StripeRefundRefused } from "./stripe"
import { toPence } from "./money"

// The provider's name as people know it, for messages.
export const providerName = (payment: { provider: string }) =>
    ({ paypal: "PayPal", stripe: "Stripe" } as Record<string, string>)[payment.provider] ?? payment.provider

// Who a cart's money is waiting on (see AWAITING_PROVIDER): the provider of its
// pending payment, or of the payment its pending refund is against.
export const awaitedProvider = (cart: Pick<ICart, "payments" | "refunds">) => {
    const refunding = cart.refunds.find((r) => r.status === "pending")
    const payment = cart.payments.find((p) => p.status === "pending") ??
        cart.payments.find((p) => refunding && String(p._id) === String(refunding.paymentId))
    return payment ? providerName(payment) : "the payment provider"
}

// The provider refused the refund, or it was never sent: nothing was refunded.
// Any other error from refundPayment leaves the outcome unknown.
export class RefundRefused extends Error {}

// Refunds `amount` (in the payment's currency) of a payment of cart `cartId`.
// `requestId` must be unique to this refund and stable across retries: the
// provider uses it so the same refund can't happen twice. Throws RefundRefused
// when nothing was refunded.
export const refundPayment = async (
    payment: IPayment,
    amount: number,
    requestId: string,
    cartId: unknown
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
        case "stripe": {
            // Stripe answers a repeated key with the original refund, but only
            // for 24 hours, and replays a cached error too (see findProviderRefund).
            // The metadata finds the refund again, and its cart (a refund that
            // fails later, S34).
            try {
                const refund = await createRefund({
                    charge: payment.providerPaymentId,
                    amount: toPence(amount),
                    metadata: { requestId, cartId: String(cartId), paymentId: String(payment._id) },
                }, requestId)
                // Accepted: on its way. One that fails later is S34's.
                return { providerRefundId: refund.id }
            } catch (error) {
                throw error instanceof StripeRefundRefused ? new RefundRefused(error.message) : error
            }
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
        case "stripe": {
            // Every page: a resend after Stripe's 24 hours of idempotency is a
            // new request, safe only because the whole list showed none.
            const refund = (await listRefunds(payment.providerCheckoutId)).find((r) => r.metadata?.requestId === requestId)
            return refund
                ? { providerRefundId: refund.id, failed: refundUndone(refund) }
                : null
        }
        default:
            throw new Error(`Refunds aren't supported for ${providerName(payment)}`)
    }
}

// Where the provider says a payment it hasn't confirmed yet stands: `completed`
// (the money is ours; a refund since doesn't change that), `failed` (nothing
// was taken), or still `pending`, with the provider's id for the money when it
// has one (Stripe: the charge). Throws if the provider can't be asked.
export const checkProviderPayment = async (payment: IPayment): Promise<{ status: PaymentStatus; providerPaymentId?: string }> => {
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
                    return { status: "completed" }
                case "DECLINED":
                case "FAILED":
                    return { status: "failed" }
                default:
                    return { status: "pending" }
            }
        }
        case "stripe": {
            const intent = await retrieveIntent(payment.providerCheckoutId)
            switch (intent.status) {
                case "succeeded": {
                    // Its charge, if it was recorded while processing without one.
                    return { status: "completed", providerPaymentId: chargeIdOf(intent) }
                }
                case "canceled":
                    return { status: "failed" }
                case "requires_payment_method":
                    // Failed, but the diner's sheet could still confirm it
                    // again (a hold nobody would capture): cancelled first.
                    // A cancel that fails throws, so it isn't marked failed.
                    await cancelIntent(payment.providerCheckoutId)
                    return { status: "failed" }
                default:
                    return { status: "pending" }
            }
        }
        default:
            throw new Error(`Payments can't be checked for ${providerName(payment)}`)
    }
}
