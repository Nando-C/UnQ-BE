// Minimal, dependency-free PayPal Orders v2 client used to verify that a split
// checkout was actually paid. Uses the native `fetch` (Node >= 20). Credentials
// come from the environment and are never logged.

const apiBase = () => process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com"

export interface PayPalAmount {
    currency_code?: string
    value?: string
}

export interface PayPalOrder {
    id: string
    status: string
    purchase_units?: Array<{
        amount?: PayPalAmount
        payments?: {
            captures?: Array<{
                status?: string
                amount?: PayPalAmount
            }>
        }
    }>
}

// Client-credentials OAuth token — required to call the Orders API.
const getAccessToken = async (): Promise<string> => {
    const clientId = process.env.PAYPAL_CLIENT_ID
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET

    if (!clientId || !clientSecret) {
        throw new Error("PayPal credentials are not configured")
    }

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
