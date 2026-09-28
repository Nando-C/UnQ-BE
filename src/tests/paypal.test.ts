import { jest, describe, it, expect, afterEach } from "@jest/globals"
import { refundCapture } from "../lib/paypal"

// The PayPal client's refund request, with the network faked: the first call
// is the OAuth token, the second the refund.
const fakeFetch = (refund: { status: number; body: unknown }) =>
    jest.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "TOKEN" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(refund.body), { status: refund.status }))

afterEach(() => {
    jest.restoreAllMocks()
})

describe("refundCapture", () => {
    it("refunds part of a capture with an idempotency key, returning PayPal's refund id", async () => {
        const fetch = fakeFetch({ status: 201, body: { id: "REF-9", status: "COMPLETED" } })

        const id = await refundCapture("CAP-1", { value: "4.50", currency: "GBP", requestId: "refund-123" })

        expect(id).toBe("REF-9")
        const [url, init] = fetch.mock.calls[1] as [string, RequestInit]
        expect(url).toMatch(/\/v2\/payments\/captures\/CAP-1\/refund$/)
        expect(init.headers).toMatchObject({ Authorization: "Bearer TOKEN", "PayPal-Request-Id": "refund-123" })
        expect(JSON.parse(init.body as string)).toEqual({ amount: { value: "4.50", currency_code: "GBP" } })
    })

    it("refunds in full with an empty body when no amount is given", async () => {
        const fetch = fakeFetch({ status: 201, body: { id: "REF-1" } })

        await refundCapture("CAP-1")

        const [, init] = fetch.mock.calls[1] as [string, RequestInit]
        expect(init.body).toBeUndefined()
        expect(init.headers).not.toHaveProperty("PayPal-Request-Id")
    })

    it("fails with PayPal's own reason", async () => {
        fakeFetch({
            status: 422,
            body: { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.",
                details: [{ description: "The refund amount must be less than or equal to the capture amount that has not yet been refunded." }] },
        })

        await expect(refundCapture("CAP-1", { value: "99.00", currency: "GBP", requestId: "r" })).rejects.toThrow(
            "PayPal refund failed (422): The refund amount must be less than or equal to the capture amount that has not yet been refunded.")
    })
})
