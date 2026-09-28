// Minimal, dependency-free PayPal Orders v2 client used to verify that a split
// checkout was actually paid. Uses the native `fetch` (Node >= 20). Credentials
// come from the environment and are never logged.

import env from "../settings/env"

const apiBase = () => env.PAYPAL_API_BASE

export interface PayPalAmount {
    currency_code?: string
    value?: string
}

export interface PayPalOrder {
    id: string
    status: string
    purchase_units?: Array<{
        amount?: PayPalAmount
        // Binds a server-created order to a specific cart + payer ("<cartId>:<userId>").
        custom_id?: string
        payments?: {
            captures?: Array<{
                id?: string
                status?: string
                amount?: PayPalAmount
            }>
        }
    }>
}

// Client-credentials OAuth token — required to call the Orders API.
const getAccessToken = async (): Promise<string> => {
    const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = env

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")

    const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
        method: "POST",
        headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
    })

    if (!res.ok) {
        throw new Error(`PayPal auth request failed (${res.status})`)
    }

    const data = (await res.json()) as { access_token?: string }
    if (!data.access_token) {
        throw new Error("PayPal auth response contained no access_token")
    }

    return data.access_token
}

// Fetch a single order from the Orders v2 API so the caller can verify its
// status, currency, and captured amount server-side.
export const getOrder = async (orderId: string): Promise<PayPalOrder> => {
    const token = await getAccessToken()

    const res = await fetch(`${apiBase()}/v2/checkout/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
        throw new Error(`PayPal order lookup failed (${res.status})`)
    }

    return (await res.json()) as PayPalOrder
}

// Create an order server-side for the exact amount due. `customId` binds the
// order to the cart + payer it was created for ("<cartId>:<userId>"), so a
// captured order can only ever settle the checkout it was minted for. Returns
// the new order id, which the buyer approves in the PayPal popup.
export const createOrder = async (amount: string, customId: string): Promise<string> => {
    const token = await getAccessToken()

    const res = await fetch(`${apiBase()}/v2/checkout/orders`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            intent: "CAPTURE",
            purchase_units: [
                {
                    amount: { currency_code: "GBP", value: amount },
                    custom_id: customId,
                },
            ],
        }),
    })

    if (!res.ok) {
        throw new Error(`PayPal order creation failed (${res.status})`)
    }

    const data = (await res.json()) as { id?: string }
    if (!data.id) {
        throw new Error("PayPal order creation response contained no id")
    }

    return data.id
}

// Capture (charge) a buyer-approved order. Returns the full order body so the
// caller can read the capture's id (needed for a possible refund) and status.
export const captureOrder = async (orderId: string): Promise<PayPalOrder> => {
    const token = await getAccessToken()

    const res = await fetch(`${apiBase()}/v2/checkout/orders/${orderId}/capture`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
    })

    if (!res.ok) {
        throw new Error(`PayPal order capture failed (${res.status})`)
    }

    return (await res.json()) as PayPalOrder
}

// PayPal answered and refused the refund (a 4xx), or it was never sent (no
// token): nothing was refunded. Anything else refundCapture throws (a network
// error, a timeout, a 5xx) leaves the outcome unknown: PayPal may have refunded.
export class PayPalRefundRefused extends Error {}

// Refund a capture. With no `partial`, in full (empty body): used to make the
// buyer whole if a conflict is discovered in the tiny window after capture.
// With `partial`, that amount only (a manager refunding some items), sent with
// a PayPal-Request-Id so a retried request can never refund twice: PayPal
// answers a repeated id with the original refund. Returns PayPal's refund id.
export const refundCapture = async (
    captureId: string,
    partial?: { value: string; currency: string; requestId: string }
): Promise<string | undefined> => {
    const token = await getAccessToken().catch((error: Error) => {
        throw new PayPalRefundRefused(error.message)
    })

    const res = await fetch(`${apiBase()}/v2/payments/captures/${captureId}/refund`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...(partial ? { "PayPal-Request-Id": partial.requestId } : {}),
        },
        ...(partial
            ? { body: JSON.stringify({ amount: { value: partial.value, currency_code: partial.currency } }) }
            : {}),
    })

    if (!res.ok) {
        // PayPal's reason, e.g. "The refund amount must be less than or equal to
        // the capture amount that has not yet been refunded."
        const body = (await res.json().catch(() => null)) as
            | { message?: string; details?: { description?: string }[] }
            | null
        const reason = body?.details?.[0]?.description ?? body?.message
        const message = `PayPal refund failed (${res.status})${reason ? `: ${reason}` : ""}`
        throw res.status < 500 ? new PayPalRefundRefused(message) : new Error(message)
    }

    const data = (await res.json().catch(() => null)) as { id?: string } | null
    return data?.id
}
