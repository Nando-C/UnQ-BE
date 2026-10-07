import { jest } from "@jest/globals"
import type * as StripeLib from "../lib/stripe"

// An in-memory Stripe for the suites, standing in for lib/stripe.ts:
//
//   jest.mock("../lib/stripe", () => jest.requireActual<typeof import("./fakeStripe")>("./fakeStripe").stripeMock())
//
// Intents and refunds live in `fakeStripe`, and change the way Stripe changes
// them. Each call is a jest.fn, so a test can make one fail. The diner's side
// (entering a card, a bank check) is played with authorise() and set().

const actual = jest.requireActual<typeof StripeLib>("../lib/stripe")

type Charge = { id: string; object: "charge"; amount: number; amount_refunded: number }
type Intent = {
    id: string
    object: "payment_intent"
    amount: number
    amount_capturable: number
    amount_received: number
    currency: string
    status: string
    metadata: Record<string, string>
    latest_charge: Charge | null
    client_secret: string
}
type Refund = {
    id: string
    object: "refund"
    amount: number
    status: string
    metadata: Record<string, string>
    payment_intent: string
    charge: string
}

let seq = 0
const intents = new Map<string, Intent>()
const refunds: Refund[] = []
const refundKeys = new Map<string, Refund>()

const copy = <T>(value: T): T => structuredClone(value)
const intentOf = (id: string) => {
    const intent = intents.get(id)
    if (!intent) throw new Error(`No such payment_intent: '${id}'`)
    return intent
}

export const fakeStripe = {
    intents,
    refunds,
    // Empty, and every call back to the fake (a test's mock*Once undone).
    reset() {
        intents.clear()
        refunds.length = 0
        refundKeys.clear()
        for (const [fn, impl] of calls) fn.mockReset().mockImplementation(impl as never)
    },
    // The diner's card authorised: Stripe holds the amount.
    authorise(id: string) {
        const intent = intentOf(id)
        intent.status = "requires_capture"
        intent.amount_capturable = intent.amount
        intent.latest_charge = { id: `ch_${++seq}`, object: "charge", amount: intent.amount, amount_refunded: 0 }
    },
    set(id: string, patch: Partial<Intent>) {
        Object.assign(intentOf(id), patch)
    },
    get(id: string) {
        return intentOf(id)
    },
}

const createIntent = jest.fn(async (amount: number, metadata: Record<string, string>) => {
    const id = `pi_${++seq}`
    const intent: Intent = {
        id, object: "payment_intent", amount, amount_capturable: 0, amount_received: 0, currency: "gbp",
        status: "requires_payment_method", metadata, latest_charge: null, client_secret: `${id}_secret_x`,
    }
    intents.set(id, intent)
    return copy(intent)
})

const retrieveIntent = jest.fn(async (id: string) => copy(intentOf(id)))

const captureIntent = jest.fn(async (id: string, idempotencyKey: string) => {
    void idempotencyKey
    const intent = intentOf(id)
    if (intent.status !== "requires_capture") {
        throw new actual.StripeCaptureRefused(`This PaymentIntent could not be captured because it has a status of ${intent.status}.`)
    }
    intent.status = "succeeded"
    intent.amount_received = intent.amount_capturable
    intent.amount_capturable = 0
    return copy(intent)
})

const cancelIntent = jest.fn(async (id: string) => {
    const intent = intentOf(id)
    if (!["requires_payment_method", "requires_capture", "requires_confirmation", "requires_action"].includes(intent.status)) {
        throw new Error(`You cannot cancel this PaymentIntent because it has a status of ${intent.status}.`)
    }
    intent.status = "canceled"
    intent.amount_capturable = 0
    return copy(intent)
})

const createRefund = jest.fn(async (
    params: { charge?: string; payment_intent?: string; amount?: number; metadata: Record<string, string> },
    idempotencyKey: string
) => {
    const known = refundKeys.get(idempotencyKey)
    if (known) return copy(known)
    const intent = [...intents.values()].find((i) =>
        (params.payment_intent && i.id === params.payment_intent) || (params.charge && i.latest_charge?.id === params.charge))
    const charge = intent?.latest_charge
    if (!intent || !charge || intent.status !== "succeeded") throw new actual.StripeRefundRefused("No such charge", "resource_missing")
    const left = charge.amount - charge.amount_refunded
    const amount = params.amount ?? left
    if (left === 0) throw new actual.StripeRefundRefused("Charge has already been refunded.", "charge_already_refunded")
    if (amount > left) throw new actual.StripeRefundRefused("Refund amount is greater than unrefunded amount on charge", "amount_too_large")
    charge.amount_refunded += amount
    const refund: Refund = {
        id: `re_${++seq}`, object: "refund", amount, status: "succeeded",
        metadata: params.metadata, payment_intent: intent.id, charge: charge.id,
    }
    refunds.push(refund)
    refundKeys.set(idempotencyKey, refund)
    return copy(refund)
})

const listRefunds = jest.fn(async (paymentIntent: string) => copy(refunds.filter((r) => r.payment_intent === paymentIntent)))

const calls = [
    [createIntent, createIntent.getMockImplementation()],
    [retrieveIntent, retrieveIntent.getMockImplementation()],
    [captureIntent, captureIntent.getMockImplementation()],
    [cancelIntent, cancelIntent.getMockImplementation()],
    [createRefund, createRefund.getMockImplementation()],
    [listRefunds, listRefunds.getMockImplementation()],
] as [jest.Mock, unknown][]

// The module as the suites see it: the fake calls, and the real helpers and
// error classes.
export const stripeMock = () => ({
    StripeCaptureRefused: actual.StripeCaptureRefused,
    StripeRefundRefused: actual.StripeRefundRefused,
    chargeIdOf: actual.chargeIdOf,
    createIntent,
    retrieveIntent,
    captureIntent,
    cancelIntent,
    createRefund,
    listRefunds,
})
