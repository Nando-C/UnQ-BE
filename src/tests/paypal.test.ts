import { jest, describe, it, expect, afterEach } from "@jest/globals"
import { refundCapture, findRefund, captureOrder, PayPalRefundRefused, PayPalCaptureRefused } from "../lib/paypal"

// The PayPal client's refund request, with the network faked: the first call
// is the OAuth token, the second the request (a refund or a capture).
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
        // Labelled with the same id, so findRefund can find it on the order.
        expect(JSON.parse(init.body as string)).toEqual({ amount: { value: "4.50", currency_code: "GBP" }, custom_id: "refund-123" })
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

    it("says it was refused on a 4xx, when nothing was refunded", async () => {
        fakeFetch({ status: 422, body: { message: "Unprocessable" } })
        await expect(refundCapture("CAP-1", { value: "1.00", currency: "GBP", requestId: "r" }))
            .rejects.toBeInstanceOf(PayPalRefundRefused)
    })

    it.each([
        [409, "PREVIOUS_REQUEST_IN_PROGRESS"],
        [429, "RATE_LIMIT_REACHED"],
    ])("doesn't say refused on a %i, when an earlier request may still refund", async (status, name) => {
        fakeFetch({ status, body: { name, message: "Try again later" } })
        const error = await refundCapture("CAP-1", { value: "1.00", currency: "GBP", requestId: "r" }).catch((e) => e)
        expect(error).toBeInstanceOf(Error)
        expect(error).not.toBeInstanceOf(PayPalRefundRefused)
    })

    it("doesn't say refused on a 5xx, when PayPal may have refunded", async () => {
        fakeFetch({ status: 503, body: { message: "Service Unavailable" } })
        const error = await refundCapture("CAP-1", { value: "1.00", currency: "GBP", requestId: "r" }).catch((e) => e)
        expect(error).not.toBeInstanceOf(PayPalRefundRefused)
        expect(error.message).toBe("PayPal refund failed (503): Service Unavailable")
    })

    it("doesn't say refused when the refund request never got an answer", async () => {
        jest.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "TOKEN" }), { status: 200 }))
            .mockRejectedValueOnce(new TypeError("fetch failed"))
        const error = await refundCapture("CAP-1", { value: "1.00", currency: "GBP", requestId: "r" }).catch((e) => e)
        expect(error).toBeInstanceOf(TypeError)
        expect(error).not.toBeInstanceOf(PayPalRefundRefused)
    })

    it("says refused when it couldn't sign in to PayPal, as the refund was never sent", async () => {
        jest.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 401 }))
        await expect(refundCapture("CAP-1", { value: "1.00", currency: "GBP", requestId: "r" }))
            .rejects.toBeInstanceOf(PayPalRefundRefused)
    })
})

describe("findRefund", () => {
    const orderWith = (refunds: unknown[]) => {
        jest.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "TOKEN" }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                id: "ORDER-1", status: "COMPLETED", purchase_units: [{ payments: { refunds } }],
            }), { status: 200 }))
    }

    it("finds the refund sent with that id on the order", async () => {
        orderWith([{ id: "R1", status: "COMPLETED", custom_id: "other" }, { id: "R2", status: "PENDING", custom_id: "refund-123" }])
        expect(await findRefund("ORDER-1", "refund-123")).toEqual({ id: "R2", status: "PENDING" })
    })

    it("is null when the order has no such refund", async () => {
        orderWith([])
        expect(await findRefund("ORDER-1", "refund-123")).toBeNull()
    })
})


describe("captureOrder", () => {
    it.each([400, 422])("says refused on a %i, when nothing was charged", async (status) => {
        fakeFetch({ status, body: { name: "UNPROCESSABLE_ENTITY" } })
        await expect(captureOrder("ORDER-1")).rejects.toBeInstanceOf(PayPalCaptureRefused)
    })

    it("doesn't say refused when an earlier request already captured the order", async () => {
        fakeFetch({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } })
        const error = await captureOrder("ORDER-1").catch((e) => e)
        expect(error).not.toBeInstanceOf(PayPalCaptureRefused)
        expect(error.message).toBe("PayPal order capture failed (422): ORDER_ALREADY_CAPTURED")
    })

    it.each([409, 429, 500, 503])("doesn't say refused on a %i, when PayPal may have charged", async (status) => {
        fakeFetch({ status, body: {} })
        const error = await captureOrder("ORDER-1").catch((e) => e)
        expect(error).toBeInstanceOf(Error)
        expect(error).not.toBeInstanceOf(PayPalCaptureRefused)
    })

    it("doesn't say refused when the capture request never got an answer", async () => {
        jest.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "TOKEN" }), { status: 200 }))
            .mockRejectedValueOnce(new TypeError("fetch failed"))
        const error = await captureOrder("ORDER-1").catch((e) => e)
        expect(error).not.toBeInstanceOf(PayPalCaptureRefused)
    })

    it("says refused when it couldn't sign in to PayPal, as the capture was never sent", async () => {
        jest.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 401 }))
        await expect(captureOrder("ORDER-1")).rejects.toBeInstanceOf(PayPalCaptureRefused)
    })
})
