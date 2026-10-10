import { jest, describe, it, expect, beforeEach } from "@jest/globals"

// lib/stripe.ts against a stand-in for the official client: the calls it makes
// and how it sorts Stripe's answers (refused: nothing happened; anything else:
// the outcome is unknown). The other Stripe suites replace lib/stripe.ts
// itself, so this is where those rules are checked.
const mockCapture = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const mockCreateRefund = jest.fn<(...args: unknown[]) => Promise<unknown>>()
jest.mock("stripe", () => {
    const loaded = jest.requireActual<{ default?: { errors: unknown }; errors: unknown }>("stripe")
    const actual = loaded.default ?? loaded
    const Client = function () {
        return { paymentIntents: { capture: mockCapture }, refunds: { create: mockCreateRefund } }
    } as unknown as { errors: unknown }
    Client.errors = actual.errors
    return { __esModule: true, default: Client }
})

import Stripe from "stripe"
import { captureIntent, createRefund, StripeCaptureRefused, StripeRefundRefused } from "../lib/stripe"

const raw = (statusCode: number, code?: string) => ({ message: `Stripe said ${statusCode}`, statusCode, code })
const cardError = () => new Stripe.errors.StripeCardError(raw(402, "card_declined") as never)
const invalid = (statusCode: number, code?: string) => new Stripe.errors.StripeInvalidRequestError(raw(statusCode, code) as never)
const apiError = () => new Stripe.errors.StripeAPIError(raw(500) as never)
const rateLimited = () => new Stripe.errors.StripeRateLimitError(raw(429) as never)
const connection = () => new Stripe.errors.StripeConnectionError(raw(0) as never)

beforeEach(() => {
    mockCapture.mockReset()
    mockCreateRefund.mockReset()
})

describe("captureIntent", () => {
    it("captures under the idempotency key, with the charge", async () => {
        mockCapture.mockResolvedValue({ id: "pi_1", status: "succeeded" })
        await captureIntent("pi_1", "capture:pi_1:t")
        expect(mockCapture).toHaveBeenCalledWith("pi_1", { expand: ["latest_charge"] }, { idempotencyKey: "capture:pi_1:t" })
    })

    it.each([["a card error", cardError], ["an invalid request", () => invalid(400)]])("says refused on %s", async (_, error) => {
        mockCapture.mockRejectedValue(error())
        await expect(captureIntent("pi_1", "k")).rejects.toBeInstanceOf(StripeCaptureRefused)
    })

    it.each([
        ["a 409 (an earlier request still running)", () => invalid(409)],
        ["a 429", rateLimited],
        ["a 5xx", apiError],
        ["no answer", connection],
    ])("doesn't say refused on %s, when it may have captured", async (_, error) => {
        mockCapture.mockRejectedValue(error())
        const thrown = await captureIntent("pi_1", "k").catch((e: unknown) => e)
        expect(thrown).not.toBeInstanceOf(StripeCaptureRefused)
    })
})

describe("createRefund", () => {
    const params = { payment_intent: "pi_1", metadata: { late: "true" } }

    it("returns a refund Stripe accepted, pending or made", async () => {
        for (const status of ["pending", "succeeded"]) {
            mockCreateRefund.mockResolvedValueOnce({ id: "re_1", status })
            await expect(createRefund(params, "k")).resolves.toMatchObject({ id: "re_1" })
        }
        expect(mockCreateRefund).toHaveBeenCalledWith(params, { idempotencyKey: "k" })
    })

    it("says refused, with Stripe's reason, for one it made and that failed or was cancelled", async () => {
        mockCreateRefund.mockResolvedValueOnce({ id: "re_1", status: "failed", failure_reason: "expired_or_canceled_card" })
        await expect(createRefund(params, "k")).rejects.toMatchObject({ code: "expired_or_canceled_card" })
        mockCreateRefund.mockResolvedValueOnce({ id: "re_2", status: "canceled", failure_reason: null })
        const thrown = await createRefund(params, "k").catch((e: unknown) => e)
        expect(thrown).toBeInstanceOf(StripeRefundRefused)
        expect(thrown).toMatchObject({ code: "canceled" })
    })

    it("says refused, with Stripe's code, on an invalid request", async () => {
        mockCreateRefund.mockRejectedValue(invalid(400, "charge_already_refunded"))
        await expect(createRefund(params, "k")).rejects.toMatchObject({ code: "charge_already_refunded" })
        await expect(createRefund(params, "k")).rejects.toBeInstanceOf(StripeRefundRefused)
    })

    it.each([["a 409", () => invalid(409)], ["a 429", rateLimited], ["a 5xx", apiError], ["no answer", connection]])(
        "doesn't say refused on %s, when it may have refunded",
        async (_, error) => {
            mockCreateRefund.mockRejectedValue(error())
            const thrown = await createRefund(params, "k").catch((e: unknown) => e)
            expect(thrown).not.toBeInstanceOf(StripeRefundRefused)
        }
    )
})
