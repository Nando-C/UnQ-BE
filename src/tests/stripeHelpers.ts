import { jest, beforeAll, beforeEach, afterEach } from "@jest/globals"
import request from "supertest"
import Stripe from "stripe"
import app from "../server"
import { authFor } from "./helpers"
import { fakeStripe } from "./fakeStripe"
import CartModel from "../services/carts/model"
import StripeCheckoutModel from "../services/carts/stripeCheckout"
import { stripeTiming } from "../services/carts/stripeFinish"

// Every Stripe suite: the route's wait for another finisher shortened, the
// fake emptied before each test, and a test's mocks undone after it. (The
// suite's own `jest.mock("../lib/stripe", …)` line stays in its file: hoisted.)
export const useFakeStripe = () => {
    beforeAll(() => {
        stripeTiming.waitMs = 400
        stripeTiming.pollMs = 50
    })
    beforeEach(() => fakeStripe.reset())
    afterEach(() => { jest.restoreAllMocks() })
}

// The diner's notices for the suites' £6.00 payment (stripeCheckout.ts's noticeText).
export const WENT_THROUGH = "Your card payment of £6.00 went through"
export const BEING_CONFIRMED = "Your card payment of £6.00 is being confirmed: your items are held for you"
export const FAILED = "Your card payment of £6.00 didn't go through: nothing was taken. Those items are unpaid again."
export const NOT_CHARGED = "Your card payment of £6.00 didn't go through: nothing was charged"

// For the Stripe suites, which mock lib/stripe with fakeStripe. A shop with a
// table and an item (`qty` ordered at `price`), Ada's cart with `select` of
// them selected to pay, and the calls her checkout makes.
export const stripeTable = async ({ qty = 2, price = 3, select }: { qty?: number; price?: number; select?: number } = {}) => {
    const owner = await authFor("shopMg")
    const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id as string
    const tableId = (await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name: "T1" })).body._id as string
    const latte = (await request(app).post(`/shops/${shopId}/menu`).set("Cookie", owner.cookies)
        .send({ name: "Latte", short_description: "x", price, category: "drinks" })).body._id as string
    const ada = await authFor("customer")
    const cartId = (await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", ada.cookies)
        .send({ menuId: latte, qty })).body._id as string
    type Diner = typeof ada
    const select_ = (who: Diner, q: number) =>
        request(app).post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`).set("Cookie", who.cookies).send({ menuId: latte, qty: q })
    if ((select ?? qty) > 0) await select_(ada, select ?? qty)

    const create = (who: Diner = ada, table = tableId) =>
        request(app).post(`/carts/tables/${table}/${cartId}/createStripeCheckout`).set("Cookie", who.cookies)
    const capture = (paymentIntentId: string, who: Diner = ada, cart = cartId) =>
        request(app).post(`/carts/tables/${tableId}/${cart}/captureStripeCheckout`).set("Cookie", who.cookies).send({ paymentIntentId })
    // Ada's card entered and authorised: the intent awaits capture.
    const authorised = async (who: Diner = ada) => {
        const res = await create(who)
        if (res.status !== 200) throw new Error(`createStripeCheckout answered ${res.status}: ${res.body.message}`)
        const pi = res.body.paymentIntentId as string
        fakeStripe.authorise(pi)
        return pi
    }
    const record = (pi: string) => StripeCheckoutModel.findById(pi).lean()
    const cart = () => CartModel.findById(cartId)
    // The table as a diner sees it (a 404 with notices once no cart is open).
    const view = (who: Diner = ada) => request(app).get(`/carts/tables/${tableId}`).set("Cookie", who.cookies)
    const messages = async (who: Diner = ada) => ((await view(who)).body.notices as { message: string }[]).map((n) => n.message)

    return { owner, shopId, tableId, latte, ada, cartId, select: select_, create, capture, authorised, record, cart, view, messages }
}

export type Table = Awaited<ReturnType<typeof stripeTable>>

export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000)
export const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

// A record's fields written as they'd be later (timestamps included).
export const setRecord = (pi: string, fields: Record<string, unknown>) =>
    StripeCheckoutModel.collection.updateOne({ _id: pi as never }, { $set: fields })

// Claimed by someone else: a holder with a live lease, or (`expired`) one that
// stopped without finishing.
export const heldElsewhere = (pi: string, { expired = false, state = "finishing" } = {}) =>
    setRecord(pi, { state, token: "someone-else", leaseUntil: new Date(Date.now() + (expired ? -1000 : 60_000)) })

// An event as Stripe posts it to the webhook: `object` is the intent or refund,
// signed with the endpoint's secret unless a `signature` is given (null: none
// sent).
let sent = 0
export const deliver = (type: string, object: unknown, { signature, id }: { signature?: string | null; id?: string } = {}) => {
    const payload = JSON.stringify({
        id: id ?? `evt_${++sent}`, object: "event", type, api_version: "2026-09-30.endive",
        created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 1, request: null, data: { object },
    })
    const header = signature === undefined
        ? Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! })
        : signature
    const req = request(app).post("/payments/stripe/webhook").set("Content-Type", "application/json")
    if (header !== null) req.set("Stripe-Signature", header)
    return req.send(payload)
}

// A refund as Stripe reports it in refund.failed, for `reason`.
export const failedRefund = (
    refund: { id: string; metadata: Record<string, string>; payment_intent: string; amount: number },
    reason: string | null = "expired_or_canceled_card"
) => ({ ...refund, object: "refund", status: "failed", currency: "gbp", failure_reason: reason })
