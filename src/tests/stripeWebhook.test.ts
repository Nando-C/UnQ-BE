import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals"

// Stripe replaced by the in-memory fake, before the app is imported. The
// signature check (lib/stripeWebhook.ts) stays real: events are signed with
// the test secret, as Stripe signs them.
jest.mock("../lib/stripe", () => jest.requireActual<typeof import("./fakeStripe")>("./fakeStripe").stripeMock())

import request from "supertest"
import Stripe from "stripe"
import "./setup"
import app from "../server"
import * as stripe from "../lib/stripe"
import { fakeStripe } from "./fakeStripe"
import { stripeTable, minutesAgo, setRecord, heldElsewhere } from "./stripeHelpers"
import CartModel from "../services/carts/model"
import StripeCheckoutModel, { syncRecordFromCart } from "../services/carts/stripeCheckout"
import OrderModel from "../services/orders/model"
import { REFUND_REOPENS, stripeTiming, sweepStripeCheckouts } from "../services/carts/stripeFinish"

const m = jest.mocked(stripe)

beforeAll(() => {
    stripeTiming.waitMs = 400
    stripeTiming.pollMs = 50
})
beforeEach(() => fakeStripe.reset())
afterEach(() => { jest.restoreAllMocks() })

const WENT_THROUGH = "Your card payment of £6.00 went through"
const BEING_CONFIRMED = "Your card payment of £6.00 is being confirmed: your items are held for you"
const FAILED = "Your card payment of £6.00 didn't go through: nothing was taken. Those items are unpaid again."

type Table = Awaited<ReturnType<typeof stripeTable>>

// An event as Stripe posts it: `object` is the intent or refund, signed with
// the endpoint's secret unless a `signature` is given (null: none sent).
let sent = 0
const deliver = (type: string, object: unknown, { signature, id }: { signature?: string | null; id?: string } = {}) => {
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
// An event about intent `pi`, with the intent as Stripe has it now.
const aboutIntent = (type: string, pi: string) => deliver(type, fakeStripe.get(pi))

// Ada authorised, then closed the tab: only the webhook (or the sweep) can finish it.
const leftAuthorised = (t: Table) => t.authorised()

// Recorded as pending by the webhook (Ada had left).
const pendingCard = async () => {
    const t = await stripeTable()
    const pi = await t.authorised()
    fakeStripe.set(pi, { status: "processing", amount_capturable: 0 })
    expect((await aboutIntent("payment_intent.amount_capturable_updated", pi)).status).toBe(200)
    expect((await t.cart())!.payments[0].status).toBe("pending")
    return { t, pi }
}

const noticeIds = async (t: Table) => ((await t.view()).body.notices as { _id: string }[]).map((n) => n._id)

// --------------------------------------------------------------------------

describe("the signature", () => {
    it.each([
        ["missing", null],
        ["signed with another secret", Stripe.webhooks.generateTestHeaderString({ payload: "{}", secret: "whsec_someone_else" })],
        ["not a signature", "nonsense"],
    ])("is refused (400) when %s, and nothing is done", async (_, signature) => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)

        const res = await deliver("payment_intent.amount_capturable_updated", fakeStripe.get(pi), { signature })

        expect([res.status, res.body.message]).toEqual([400, "Invalid Stripe signature"])
        expect(m.retrieveIntent).not.toHaveBeenCalled()
        expect(await t.record(pi)).toMatchObject({ state: "open" })
    })

    it("is refused for a body changed after signing", async () => {
        const payload = JSON.stringify({ id: "evt_x", object: "event", type: "ping", data: { object: {} } })
        const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! })

        const res = await request(app).post("/payments/stripe/webhook").set("Content-Type", "application/json")
            .set("Stripe-Signature", signature).send(payload.replace("ping", "pong"))

        expect(res.status).toBe(400)
    })
})

describe("an event it doesn't act on", () => {
    it("is answered 200: an unrelated type (no sign-in needed)", async () => {
        const res = await deliver("customer.created", { id: "cus_1", object: "customer" })
        expect([res.status, res.body]).toEqual([200, { received: true }])
    })

    it("is the webhook's path however Stripe's dashboard spells it (case, a trailing slash)", async () => {
        const payload = JSON.stringify({ id: "evt_path", object: "event", type: "customer.created", data: { object: {} } })
        const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! })
        for (const path of ["/payments/stripe/webhook/", "/Payments/Stripe/Webhook?x=1"]) {
            const res = await request(app).post(path).set("Content-Type", "application/json").set("Stripe-Signature", signature).send(payload)
            expect([path, res.status]).toEqual([path, 200])
        }
    })

    it("is answered 200: an intent UnQ didn't make", async () => {
        const intent = { id: "pi_elsewhere", object: "payment_intent", status: "succeeded", metadata: {} }
        for (const type of ["payment_intent.amount_capturable_updated", "payment_intent.succeeded", "payment_intent.canceled"]) {
            expect((await deliver(type, intent)).status).toBe(200)
        }
        expect(await StripeCheckoutModel.countDocuments()).toBe(0)
    })
})

// --------------------------------------------------------------------------

describe("an authorised intent (payment_intent.amount_capturable_updated)", () => {
    it("is finished for a diner who never came back, who sees the outcome on their next fetch", async () => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)

        const res = await aboutIntent("payment_intent.amount_capturable_updated", pi)

        expect(res.status).toBe(200)
        expect(fakeStripe.get(pi).status).toBe("succeeded")
        const cart = (await t.cart())!
        expect(cart.payments[0]).toMatchObject({ provider: "stripe", providerCheckoutId: pi, status: "completed" })
        // Not logged as finished after the diner left: the diner's own
        // capture call is often still on its way (only the sweep logs it).
        expect(cart.managerLog.filter((l) => l.action === "stripeFinished")).toEqual([])
        expect(await t.record(pi)).toMatchObject({ state: "recorded", paymentStatus: "completed" })
        expect(await t.messages()).toEqual([WENT_THROUGH])
    })

    it("tells the pending text for one still processing", async () => {
        const { t, pi } = await pendingCard()
        expect(await t.record(pi)).toMatchObject({ state: "recorded", paymentStatus: "pending" })
        expect(await t.messages()).toEqual([BEING_CONFIRMED])
    })

    it("does nothing while the diner's own request holds it, and that request's outcome stands", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        await heldElsewhere(pi)
        const before = await t.record(pi)

        const res = await aboutIntent("payment_intent.amount_capturable_updated", pi)

        expect(res.status).toBe(200)
        expect(m.captureIntent).not.toHaveBeenCalled()
        expect(await t.record(pi)).toMatchObject({ state: "finishing", token: before!.token })
        expect(await StripeCheckoutModel.countDocuments()).toBe(1)
    })

    it("arriving while the diner's capture runs: one capture, one payment, and the diner's answer from it", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()

        const [answer, event] = await Promise.all([t.capture(pi), aboutIntent("payment_intent.amount_capturable_updated", pi)])

        expect(answer.status).toBe(200)
        expect(event.status).toBe(200)
        expect(m.captureIntent).toHaveBeenCalledTimes(1)
        expect((await t.cart())!.payments).toHaveLength(1)
        expect(await t.messages()).toEqual([])
    })

    it("cancels it when the checks fail (nothing taken), 200", async () => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)
        await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qty": 3, "split.0.qty": 3 } })

        const res = await aboutIntent("payment_intent.amount_capturable_updated", pi)

        expect(res.status).toBe(200)
        expect(fakeStripe.get(pi).status).toBe("canceled")
        expect(await t.record(pi)).toMatchObject({ state: "released" })
        expect((await t.cart())!.payments).toEqual([])
    })

    it("answers 500 for its own unclear capture, with the claim given up, and the retry records it", async () => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)
        m.captureIntent.mockRejectedValueOnce(new Error("socket hang up"))
        jest.spyOn(console, "error").mockImplementation(() => {})

        const first = await aboutIntent("payment_intent.amount_capturable_updated", pi)

        expect(first.status).toBe(500)
        const record = await t.record(pi)
        expect(record!.state).toBe("finishing")
        expect(record!.leaseUntil!.getTime()).toBeLessThanOrEqual(Date.now())

        const retry = await aboutIntent("payment_intent.amount_capturable_updated", pi)

        expect(retry.status).toBe(200)
        expect(await t.record(pi)).toMatchObject({ state: "recorded" })
        expect((await t.cart())!.payments).toHaveLength(1)
    })

    it("answers 500 when Stripe can't be reached, so Stripe retries", async () => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)
        m.retrieveIntent.mockRejectedValueOnce(new Error("socket hang up"))
        jest.spyOn(console, "error").mockImplementation(() => {})

        expect((await aboutIntent("payment_intent.amount_capturable_updated", pi)).status).toBe(500)
        expect((await aboutIntent("payment_intent.amount_capturable_updated", pi)).status).toBe(200)
        expect(await t.record(pi)).toMatchObject({ state: "recorded" })
    })

    it("does nothing when repeated", async () => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)
        const event = fakeStripe.get(pi)
        await deliver("payment_intent.amount_capturable_updated", event, { id: "evt_same" })
        const ids = await noticeIds(t)

        const again = await deliver("payment_intent.amount_capturable_updated", event, { id: "evt_same" })

        expect(again.status).toBe(200)
        expect(m.captureIntent).toHaveBeenCalledTimes(1)
        const cart = (await t.cart())!
        expect(cart.payments).toHaveLength(1)
        expect(cart.managerLog).toHaveLength(0)
        expect(await noticeIds(t)).toEqual(ids)
    })
})

describe("a captured intent (payment_intent.succeeded)", () => {
    it("is finished and recorded when no cart has it (a second chance after a crash)", async () => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)
        // Captured, then the holder stopped before saving the cart.
        fakeStripe.set(pi, { status: "succeeded", amount_received: 600, amount_capturable: 0 })
        await heldElsewhere(pi, { expired: true })

        const res = await aboutIntent("payment_intent.succeeded", pi)

        expect(res.status).toBe(200)
        expect(m.captureIntent).not.toHaveBeenCalled()
        expect((await t.cart())!.payments[0]).toMatchObject({ providerCheckoutId: pi, status: "completed" })
        expect(await t.record(pi)).toMatchObject({ state: "recorded" })
    })

    it("writes the order of one whose finisher stopped after saving the cart", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        await t.capture(pi)
        // The cart saved; the finisher stopped before its order and its record.
        await OrderModel.deleteMany({})
        await heldElsewhere(pi)

        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(200)

        expect(await t.record(pi)).toMatchObject({ state: "recorded", paymentStatus: "completed" })
        expect(await OrderModel.countDocuments({ cartId: t.cartId })).toBe(1)
    })

    it("arriving while the diner's capture is saving it as pending: waited for, then settled", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        const capture = m.captureIntent.getMockImplementation()!
        // Stripe answers the capture "processing" (slowly), and has it
        // succeeded by the time its event comes.
        m.captureIntent.mockImplementationOnce(async (id, key) => {
            const captured = await capture(id, key)
            fakeStripe.set(id, { status: "succeeded" })
            await new Promise((resolve) => setTimeout(resolve, 150))
            return { ...captured, status: "processing" }
        })

        const answer = t.capture(pi).then((res) => res)
        // Once the diner's request holds it, captured and saving.
        while (fakeStripe.get(pi).status !== "succeeded") await new Promise((resolve) => setTimeout(resolve, 5))
        const event = await aboutIntent("payment_intent.succeeded", pi)

        expect(event.status).toBe(200)
        expect((await t.cart())!.payments[0].status).toBe("completed")
        // Told once either way: "being confirmed" by the route, then a notice
        // that it went through; or, settled before the route answered, that.
        const { status } = await answer
        expect([status, await t.messages()]).toEqual(status === 202 ? [202, [WENT_THROUGH]] : [200, []])
    })

    it("is left to the sweep (200, at once) while a refund Stripe refused waits to be retried", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        fakeStripe.set(pi, { status: "succeeded", amount_received: 600, amount_capturable: 0 })
        const later = new Date(Date.now() + 30 * 60 * 1000)
        await heldElsewhere(pi)
        await setRecord(pi, { refunding: true, refundRetryAt: later, leaseUntil: later })

        const started = Date.now()
        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(200)
        expect(Date.now() - started).toBeLessThan(stripeTiming.waitMs)
    })

    it("is retried (500) when another finisher still holds it after the wait", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        fakeStripe.set(pi, { status: "succeeded", amount_received: 600, amount_capturable: 0 })
        await heldElsewhere(pi)
        jest.spyOn(console, "error").mockImplementation(() => {})

        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(500)
    })

    it("does nothing for one already recorded and completed", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        await t.capture(pi)
        const before = (await t.cart())!

        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(200)

        const after = (await t.cart())!
        expect(after.payments).toHaveLength(1)
        expect(after.managerLog).toHaveLength(before.managerLog.length)
        expect(await t.messages()).toEqual([])
    })
})

// --------------------------------------------------------------------------

describe("a cancelled intent (payment_intent.canceled)", () => {
    it("completes a release whose finisher stopped before recording it", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        await heldElsewhere(pi, { expired: true, state: "releasing" })
        await setRecord(pi, { status: 409, message: "Your selection changed since the order was created, please retry" })
        fakeStripe.set(pi, { status: "canceled", amount_capturable: 0 })

        expect((await aboutIntent("payment_intent.canceled", pi)).status).toBe(200)

        expect(await t.record(pi)).toMatchObject({ state: "released" })
    })
})

describe("a card declined in the sheet (payment_intent.payment_failed)", () => {
    it("leaves the record alone while nobody holds it: the diner may try another card", async () => {
        const t = await stripeTable()
        const pi = (await t.create()).body.paymentIntentId as string

        expect((await aboutIntent("payment_intent.payment_failed", pi)).status).toBe(200)

        expect(m.retrieveIntent).not.toHaveBeenCalled()
        expect(await t.record(pi)).toMatchObject({ state: "open" })
    })
})

describe("a pending card payment", () => {
    it("is completed by payment_intent.succeeded: one new notice, no cart note, a log line with no manager", async () => {
        const { t, pi } = await pendingCard()
        const [pending] = await noticeIds(t)
        fakeStripe.set(pi, { status: "succeeded" })

        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(200)

        const cart = (await t.cart())!
        expect(cart.payments[0].status).toBe("completed")
        expect(cart.notices).toEqual([])
        expect(cart.managerLog.at(-1)).toMatchObject({ action: "checkPayment" })
        expect(cart.managerLog.at(-1)!.byUserId).toBeUndefined()
        expect(await t.messages()).toEqual([WENT_THROUGH])
        expect(await noticeIds(t)).not.toContain(pending)
    })

    it("is failed by payment_intent.payment_failed: cancelled, its items unpaid again, one notice", async () => {
        const { t, pi } = await pendingCard()
        fakeStripe.set(pi, { status: "requires_payment_method" })

        expect((await aboutIntent("payment_intent.payment_failed", pi)).status).toBe(200)

        expect(fakeStripe.get(pi).status).toBe("canceled")
        const cart = (await t.cart())!
        expect(cart.payments[0].status).toBe("failed")
        expect(cart.items[0].qtyPayed).toBe(0)
        expect(cart.notices).toEqual([])
        expect(await t.messages()).toEqual([FAILED])
    })

    it("is failed by payment_intent.canceled", async () => {
        const { t, pi } = await pendingCard()
        fakeStripe.set(pi, { status: "canceled" })

        expect((await aboutIntent("payment_intent.canceled", pi)).status).toBe(200)

        expect((await t.cart())!.payments[0].status).toBe("failed")
        expect(await t.messages()).toEqual([FAILED])
    })

    it("acts on the intent as Stripe has it now, not the event's copy (events come out of order)", async () => {
        const { t, pi } = await pendingCard()
        const stale = fakeStripe.get(pi)

        expect((await deliver("payment_intent.payment_failed", stale)).status).toBe(200)

        expect((await t.cart())!.payments[0].status).toBe("pending")
    })

    it("answers 500 when Stripe can't be asked, and settles on the retry", async () => {
        const { t, pi } = await pendingCard()
        fakeStripe.set(pi, { status: "succeeded" })
        m.retrieveIntent.mockRejectedValueOnce(new Error("socket hang up"))
        jest.spyOn(console, "error").mockImplementation(() => {})

        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(500)
        expect((await t.cart())!.payments[0].status).toBe("pending")
        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(200)
        expect((await t.cart())!.payments[0].status).toBe("completed")
    })

    it("isn't synced back to pending (as from a copy of the cart read before it settled)", async () => {
        const { t, pi } = await pendingCard()
        fakeStripe.set(pi, { status: "succeeded" })
        await aboutIntent("payment_intent.succeeded", pi)
        const ids = await noticeIds(t)
        const cart = (await t.cart())!

        await syncRecordFromCart(cart, pi, { ...(await CartModel.findById(t.cartId).lean())!.payments[0], status: "pending" })

        expect(await t.record(pi)).toMatchObject({ paymentStatus: "completed" })
        expect(await noticeIds(t)).toEqual(ids)
    })

    it("answers 200 when only the sync before settling failed: the one after brought the record to the end", async () => {
        const { t, pi } = await pendingCard()
        fakeStripe.set(pi, { status: "succeeded" })
        jest.spyOn(console, "error").mockImplementation(() => {})
        const real = StripeCheckoutModel.updateOne.bind(StripeCheckoutModel)
        let calls = 0
        jest.spyOn(StripeCheckoutModel, "updateOne").mockImplementation(((...args: Parameters<typeof real>) =>
            ++calls === 1 ? Promise.reject(new Error("database blip")) : real(...args)) as never)

        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(200)
        expect(await t.record(pi)).toMatchObject({ paymentStatus: "completed" })
    })

    it("answers 500 when its record can't be synced after settling, and the retry syncs it", async () => {
        const { t, pi } = await pendingCard()
        fakeStripe.set(pi, { status: "succeeded" })
        jest.spyOn(console, "error").mockImplementation(() => {})
        // The sync after the settle (the second of the check's) fails.
        const real = StripeCheckoutModel.updateOne.bind(StripeCheckoutModel)
        let calls = 0
        const spy = jest.spyOn(StripeCheckoutModel, "updateOne").mockImplementation(((...args: Parameters<typeof real>) =>
            ++calls === 2 ? Promise.reject(new Error("database blip")) : real(...args)) as never)

        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(500)
        spy.mockRestore()
        expect((await t.cart())!.payments[0].status).toBe("completed")
        expect(await t.record(pi)).toMatchObject({ paymentStatus: "pending" })

        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(200)
        expect(await t.record(pi)).toMatchObject({ paymentStatus: "completed" })
        expect(await t.messages()).toEqual([WENT_THROUGH])
    })

    it("repairs a record left behind by a crash after the cart saved, and a repeat brings no notice back", async () => {
        const { t, pi } = await pendingCard()
        fakeStripe.set(pi, { status: "succeeded" })
        await aboutIntent("payment_intent.succeeded", pi)
        // The cart saved completed; the record's update never happened.
        await setRecord(pi, { paymentStatus: "pending" })

        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(200)

        expect(await t.record(pi)).toMatchObject({ paymentStatus: "completed" })
        expect(await t.messages()).toEqual([WENT_THROUGH])
        const ids = await noticeIds(t)

        expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(200)
        expect(await noticeIds(t)).toEqual(ids)
    })
})

// --------------------------------------------------------------------------

describe("a refund Stripe accepted, then couldn't make (refund.failed)", () => {
    const failed = (
        refund: { id: string; metadata: Record<string, string>; payment_intent: string; amount: number },
        reason: string | null = "expired_or_canceled_card"
    ) => ({ ...refund, object: "refund", status: "failed", currency: "gbp", failure_reason: reason })

    it("a manager's: logged on its cart (once) and as a server error, not reversed", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        await t.capture(pi)
        const paymentId = String((await t.cart())!.payments[0]._id)
        const res = await request(app).post(`/shops/${t.shopId}/carts/${t.cartId}/refunds`).set("Cookie", t.owner.cookies)
            .send({ paymentId, lines: [{ menuId: t.latte, qty: 1 }] })
        expect(res.status).toBe(200)
        const error = jest.spyOn(console, "error").mockImplementation(() => {})
        const event = failed(fakeStripe.refunds[0])
        const version = (await t.cart())!.__v

        expect((await deliver("refund.failed", event)).status).toBe(200)
        expect((await deliver("refund.failed", event)).status).toBe(200)

        const cart = (await t.cart())!
        const lines = cart.managerLog.filter((l) => l.action === "stripeRefundFailed")
        expect(lines).toHaveLength(1)
        expect(lines[0].byUserId).toBeUndefined()
        expect(lines[0].details).toBe(
            `£3.00 refund failed at Stripe (expired_or_canceled_card; refund ${res.body.refund._id}, Stripe's ${event.id}): ` +
            "it wasn't reversed here, so pay the diner back another way"
        )
        expect(cart.refunds[0].status).toBe("completed")
        // Moved once, so a save from a copy read before the line retries.
        expect(cart.__v).toBe(version + 1)
        expect(error).toHaveBeenCalledWith(expect.stringMatching(/^A card £3\.00 refund failed at Stripe \(expired_or_canceled_card; .*\)$/), expect.anything())
    })

    it("one made in Stripe's dashboard: a server error only, 200", async () => {
        const error = jest.spyOn(console, "error").mockImplementation(() => {})

        const res = await deliver("refund.failed", failed({ id: "re_dash", metadata: {}, payment_intent: "pi_x", amount: 100 }))

        expect(res.status).toBe(200)
        expect(error).toHaveBeenCalledWith("A card refund made outside UnQ failed at Stripe", expect.objectContaining({ paymentIntentId: "pi_x" }))
    })

    describe("a late refund (a payment that couldn't be recorded)", () => {
        // Captured, then the cart changed: refunded in full by the finisher.
        const refundedLate = async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            fakeStripe.set(pi, { status: "succeeded", amount_received: 600, amount_capturable: 0 })
            await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qtyPayed": 2 } })
            await aboutIntent("payment_intent.succeeded", pi)
            expect(await t.record(pi)).toMatchObject({ state: "refunded" })
            return { t, pi, refund: fakeStripe.refunds[0] }
        }
        // Failed for a reason a new refund may not hit (the balance was short).
        const mayClear = (refund: Parameters<typeof failed>[0]) => failed(refund, "insufficient_funds")
        // Stripe marks the refund failed, and gives the money back to the charge.
        const failsAtStripe = (pi: string, refund: Parameters<typeof failed>[0], reason: string | null) => {
            Object.assign(fakeStripe.refunds.find((r) => r.id === refund.id)!, { status: "failed" })
            fakeStripe.get(pi).latest_charge!.amount_refunded = 0
            return deliver("refund.failed", failed(refund, reason))
        }
        // The sweep's refund of one reopened, once its retry time comes.
        const refundedAgain = async (pi: string) => {
            await setRecord(pi, { leaseUntil: minutesAgo(1) })
            await sweepStripeCheckouts()
            return fakeStripe.refunds.at(-1)!
        }
        const HANDED_OVER = "Your card payment of £6.00 couldn't be refunded to your card: please contact staff about it"

        it("reopens the record for another refund, retried by the sweep once the retry time comes", async () => {
            const { t, pi, refund } = await refundedLate()
            expect(refund.metadata).toMatchObject({ late: "true" })
            expect((await t.record(pi))!.refundId).toBe(refund.id)
            const error = jest.spyOn(console, "error").mockImplementation(() => {})
            const told = await noticeIds(t)
            expect(told).toHaveLength(1)
            // Stripe gives the money back to the charge when the refund fails.
            fakeStripe.get(pi).latest_charge!.amount_refunded = 0

            expect((await deliver("refund.failed", mayClear(refund))).status).toBe(200)

            expect(error).toHaveBeenCalledWith(expect.stringContaining("failed at Stripe"), expect.objectContaining({ paymentIntentId: pi, reopened: "reopened" }))
            const reopened = await t.record(pi)
            expect(reopened).toMatchObject({ state: "finishing", refunding: true })
            expect(reopened!.refundId).toBeUndefined()
            expect(reopened!.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 25 * 60 * 1000)

            // Not before then.
            await sweepStripeCheckouts()
            expect(fakeStripe.refunds).toHaveLength(1)

            await setRecord(pi, { leaseUntil: minutesAgo(1) })
            await sweepStripeCheckouts()

            expect(fakeStripe.refunds).toHaveLength(2)
            const again = await t.record(pi)
            expect(again).toMatchObject({ state: "refunded", refundId: fakeStripe.refunds[1].id })
            expect((await t.cart())!.payments).toEqual([])
            // The same outcome: the same notice, so one dismissed stays so.
            expect(await noticeIds(t)).toEqual(told)
        })

        it("tells the manager once of a stalled save it refunds again", async () => {
            const { t, pi, refund } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})
            // A holder that stalled past its lease saved it after the refund
            // was decided; the manager was told then.
            const details = `recorded, but refunded by Stripe after a lost race: the diner wasn't charged (payment ${pi})`
            await CartModel.updateOne({ _id: t.cartId }, {
                $push: { stripePaymentIntentIds: pi, managerLog: { at: new Date(), action: "stripeRefundedRecorded", details } },
            })
            fakeStripe.get(pi).latest_charge!.amount_refunded = 0
            await deliver("refund.failed", mayClear(refund))
            await setRecord(pi, { leaseUntil: minutesAgo(1) })

            await sweepStripeCheckouts()

            expect(fakeStripe.refunds).toHaveLength(2)
            expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundedRecorded")).toHaveLength(1)
        })

        it("reopens one whose refund isn't known (its holder stopped; the next found it already refunded)", async () => {
            const { t, pi, refund } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})
            await StripeCheckoutModel.collection.updateOne({ _id: pi as never }, { $unset: { refundId: 1 } })
            fakeStripe.get(pi).latest_charge!.amount_refunded = 0

            expect((await deliver("refund.failed", mayClear(refund))).status).toBe(200)

            expect(await t.record(pi)).toMatchObject({ state: "finishing", refunding: true })
        })

        it("does nothing for a stale one once the charge is refunded in full (staff refunded it by hand since)", async () => {
            const { t, pi, refund } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})
            // Finished by a holder that found it already refunded: no refundId.
            await StripeCheckoutModel.collection.updateOne({ _id: pi as never }, { $unset: { refundId: 1 } })
            // The late refund failed; staff then refunded it all by hand.
            fakeStripe.get(pi).latest_charge!.amount_refunded = 0
            await stripe.createRefund({ payment_intent: pi, metadata: {} }, "by-hand")

            const error = jest.spyOn(console, "error").mockImplementation(() => {})

            for (const reason of ["expired_or_canceled_card", "insufficient_funds"]) {
                expect((await deliver("refund.failed", failed(refund, reason))).status).toBe(200)
            }
            expect(error).toHaveBeenCalledWith(expect.stringContaining("it changes nothing now"), expect.objectContaining({ reopened: "none" }))
            expect(error).not.toHaveBeenCalledWith(expect.stringContaining("the money is still taken"), expect.anything())

            expect(await t.record(pi)).toMatchObject({ state: "refunded" })
            expect((await t.record(pi))!.refundFailures).toBeUndefined()
            expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed")).toEqual([])
        })

        it("is retried while its finisher is still finishing the refund, then reopens it", async () => {
            const { t, pi, refund } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})
            // Between the refund and the record saying so.
            await StripeCheckoutModel.collection.updateOne({ _id: pi as never }, {
                $set: { state: "finishing", refunding: true }, $unset: { refundId: 1, refundRetryAt: 1 },
            })
            fakeStripe.get(pi).latest_charge!.amount_refunded = 0

            expect((await deliver("refund.failed", mayClear(refund))).status).toBe(500)

            await setRecord(pi, { state: "refunded", refundId: refund.id })
            expect((await deliver("refund.failed", mayClear(refund))).status).toBe(200)
            expect(await t.record(pi)).toMatchObject({ state: "finishing", refunding: true })
            // A repeat once reopened isn't retried.
            expect((await deliver("refund.failed", mayClear(refund))).status).toBe(200)
        })

        it("doesn't reopen it for a repeated event or an older refund's", async () => {
            const { t, pi, refund } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})
            await setRecord(pi, { refundId: "re_newer" })
            m.retrieveIntent.mockClear()

            expect((await deliver("refund.failed", mayClear(refund))).status).toBe(200)

            expect(await t.record(pi)).toMatchObject({ state: "refunded", refundId: "re_newer" })
            // Not even Stripe asked (an outage can't make it retried).
            expect(m.retrieveIntent).not.toHaveBeenCalled()
        })

        it("is handed to staff at once when a new refund would fail too (a closed card): logged once, the diner told", async () => {
            const { t, pi, refund } = await refundedLate()
            const error = jest.spyOn(console, "error").mockImplementation(() => {})
            const before = (await t.record(pi))!.finishedAt!

            expect((await failsAtStripe(pi, refund, "expired_or_canceled_card")).status).toBe(200)
            // Staff already told: a repeat doesn't go near the cart, or Stripe.
            const cartWrites = jest.spyOn(CartModel, "updateOne")
            m.retrieveIntent.mockClear()
            expect((await deliver("refund.failed", failed(refund))).status).toBe(200)
            expect(cartWrites).not.toHaveBeenCalled()
            expect(m.retrieveIntent).not.toHaveBeenCalled()
            cartWrites.mockRestore()

            expect(error).toHaveBeenCalledWith(expect.stringContaining("failed at Stripe"), expect.objectContaining({ reopened: "handedOver" }))
            const record = (await t.record(pi))!
            expect(record).toMatchObject({ state: "refundFailed", refunding: true, refundFailures: 1, refundId: refund.id })
            expect(record.finishedAt!.getTime()).toBeGreaterThan(before.getTime())
            const lines = (await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed")
            expect(lines.map((l) => l.details)).toEqual([
                `£6.00 card payment by Test: Stripe won't refund it, so they were charged (payment ${pi}). ` +
                "Pay them back another way, unless a cart shows this payment as paid and they didn't pay again, " +
                "or Stripe's dashboard shows they've disputed it since (their bank returns it then).",
            ])
            expect(await t.messages()).toEqual([`${HANDED_OVER} (payment ${pi})`])

            // Final: nothing refunds it again, and Stripe's events about the
            // intent aren't retried.
            await setRecord(pi, { leaseUntil: minutesAgo(1) })
            await sweepStripeCheckouts()
            expect(fakeStripe.refunds).toHaveLength(1)
            expect((await aboutIntent("payment_intent.succeeded", pi)).status).toBe(200)
            expect((await t.record(pi))!.state).toBe("refundFailed")
            // The diner asking again is told to see staff.
            const res = await t.capture(pi)
            expect([res.status, res.body.message]).toEqual([500, `Payment captured but could not be recorded or refunded — please contact staff (payment ${pi})`])
        })

        it("logs the hand-over on Stripe's retry when the log failed the first time", async () => {
            const { t, pi, refund } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})
            jest.spyOn(CartModel, "updateOne").mockRejectedValueOnce(new Error("database down"))

            expect((await failsAtStripe(pi, refund, "expired_or_canceled_card")).status).toBe(500)
            expect((await t.record(pi))!.state).toBe("refundFailed")
            expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed")).toEqual([])

            expect((await deliver("refund.failed", failed(refund))).status).toBe(200)
            expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed")).toHaveLength(1)
            expect((await t.record(pi))!.refundFailures).toBe(1)
        })

        it("tells staff only what's still taken when part was refunded by hand", async () => {
            const { t, pi, refund } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})

            // £2.00 of the £6.00 refunded by hand in Stripe's dashboard meanwhile.
            fakeStripe.get(pi).latest_charge!.amount_refunded = 0
            await stripe.createRefund({ payment_intent: pi, amount: 200, metadata: {} }, "by-hand")
            await deliver("refund.failed", failed(refund))

            expect(await t.record(pi)).toMatchObject({ state: "refundFailed", refundOwed: 400 })
            expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed").map((l) => l.details))
                .toEqual([expect.stringMatching(/^£4\.00 card payment by Test: /)])
            expect(await t.messages()).toEqual([expect.stringMatching(/^Your card payment of £4\.00 couldn't be refunded to your card: /)])
        })

        it("is handed over when Stripe hasn't taken the failed refund off the charge's total yet", async () => {
            const { t, pi, refund } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})
            expect(fakeStripe.get(pi).latest_charge!.amount_refunded).toBe(600)

            await deliver("refund.failed", failed(refund))

            expect(await t.record(pi)).toMatchObject({ state: "refundFailed", refundOwed: 600 })
        })

        it("is handed over as disputed for charge_for_pending_refund_disputed: staff don't pay back", async () => {
            const { t, pi, refund } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})

            await failsAtStripe(pi, refund, "charge_for_pending_refund_disputed")

            expect(await t.record(pi)).toMatchObject({ state: "refundFailed", disputed: true })
            expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed").map((l) => l.details))
                .toEqual([expect.stringContaining("is disputed with their bank")])
            // The diner's bank, not staff, gives it back.
            expect(await t.messages()).toEqual([
                `Your card payment of £6.00 couldn't be refunded to your card while you dispute it: your bank returns it (payment ${pi})`,
            ])
        })

        it("is refunded again when only the charge's flag says disputed (it stays once a dispute closes)", async () => {
            const { t, pi, refund } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})
            Object.assign(fakeStripe.get(pi).latest_charge!, { disputed: true })

            await failsAtStripe(pi, refund, "insufficient_funds")

            expect(await t.record(pi)).toMatchObject({ state: "finishing", refunding: true })
        })

        it.each(["lost_or_stolen_card", "charge_for_pending_refund_disputed", "merchant_request"])("is handed to staff at once for %s", async (reason) => {
            const { t, pi, refund } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})

            await failsAtStripe(pi, refund, reason)

            expect((await t.record(pi))!.state).toBe("refundFailed")
        })

        it(`is refunded again ${REFUND_REOPENS} times when it may go through, then handed to staff`, async () => {
            const { t, pi } = await refundedLate()
            jest.spyOn(console, "error").mockImplementation(() => {})
            // A missing or new reason counts as one that may clear.
            const reasons = ["insufficient_funds", null, "declined", "unknown"]

            for (const [i, reason] of reasons.entries()) {
                await failsAtStripe(pi, fakeStripe.refunds.at(-1)!, reason)
                if (i === REFUND_REOPENS) break
                expect(await t.record(pi)).toMatchObject({ state: "finishing", refundFailures: i + 1 })
                expect(await refundedAgain(pi)).toBe(fakeStripe.refunds[i + 1])
                expect((await t.record(pi))!.state).toBe("refunded")
                expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed")).toEqual([])
            }

            expect(await t.record(pi)).toMatchObject({ state: "refundFailed", refundFailures: REFUND_REOPENS + 1 })
            expect(fakeStripe.refunds).toHaveLength(REFUND_REOPENS + 1)
            expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed")).toHaveLength(1)
        })
    })
})
