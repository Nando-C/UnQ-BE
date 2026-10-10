import { jest, describe, it, expect } from "@jest/globals"

// Stripe replaced by the in-memory fake, before the app is imported.
jest.mock("../lib/stripe", () => jest.requireActual<typeof import("./fakeStripe")>("./fakeStripe").stripeMock())

import request from "supertest"
import "./setup"
import app from "../server"
import * as stripe from "../lib/stripe"
import { fakeStripe } from "./fakeStripe"
import { authFor, quiet } from "./helpers"
import { stripeTable, minutesAgo, setRecord, heldElsewhere, Table, useFakeStripe, WENT_THROUGH, BEING_CONFIRMED, FAILED, NOT_CHARGED } from "./stripeHelpers"
import CartModel from "../services/carts/model"
import { sweepStripeCheckouts } from "../services/carts/stripeFinish"

const m = jest.mocked(stripe)

useFakeStripe()



// Ada authorised, then closed the tab before her capture call: the record is
// `open`, `minutes` old, and only the sweep (or S34's webhook) can finish it.
const leftAuthorised = async (t: Table, minutes = 11) => {
    const pi = await t.authorised()
    await setRecord(pi, { createdAt: minutesAgo(minutes) })
    return pi
}

// --------------------------------------------------------------------------

describe("the sweep", () => {
    it("finishes an authorised intent whose diner never came back, and logs it for the manager", async () => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)

        await sweepStripeCheckouts()

        expect(fakeStripe.get(pi).status).toBe("succeeded")
        const cart = await t.cart()
        expect(cart!.payments[0]).toMatchObject({ provider: "stripe", providerCheckoutId: pi })
        expect(cart!.managerLog.at(-1)).toMatchObject({ action: "stripeFinished" })
        expect(cart!.managerLog.at(-1)!.byUserId).toBeUndefined()
        expect(await t.record(pi)).toMatchObject({ state: "recorded" })
    })

    it("finishes an expired claim and completes a release under way", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        await heldElsewhere(pi, { expired: true })

        const other = await stripeTable()
        const releasing = await other.authorised()
        await heldElsewhere(releasing, { expired: true, state: "releasing" })
        await setRecord(releasing, { status: 409, message: "Your selection changed since the order was created, please retry" })

        await sweepStripeCheckouts()

        expect(await t.record(pi)).toMatchObject({ state: "recorded" })
        expect(await other.record(releasing)).toMatchObject({ state: "released" })
        expect(fakeStripe.get(releasing).status).toBe("canceled")
    })

    it("leaves a sheet still in use alone, and looks at it at most every 10 minutes", async () => {
        const t = await stripeTable()
        const pi = (await t.create()).body.paymentIntentId
        await setRecord(pi, { createdAt: minutesAgo(30) })

        await sweepStripeCheckouts()
        await sweepStripeCheckouts()

        expect(m.retrieveIntent).toHaveBeenCalledTimes(1)
        expect(await t.record(pi)).toMatchObject({ state: "open", checkedAt: expect.any(Date) })
        expect(fakeStripe.get(pi).status).toBe("requires_payment_method")
    })

    it("cancels an intent still unauthorised an hour after it was created, however often it went back to open, telling nobody", async () => {
        const t = await stripeTable()
        const pi = (await t.create()).body.paymentIntentId
        // Put back to `open` by finishers lately; created over an hour ago.
        await setRecord(pi, { createdAt: minutesAgo(61), updatedAt: new Date() })

        await sweepStripeCheckouts()

        expect(fakeStripe.get(pi).status).toBe("canceled")
        expect(await t.record(pi)).toMatchObject({ state: "released" })
        expect(await t.messages()).toEqual([])
    })

    it("logs a record still unfinished two hours after it was created", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        await heldElsewhere(pi)
        await setRecord(pi, { createdAt: minutesAgo(121) })
        const errors = quiet()

        await sweepStripeCheckouts()
        await sweepStripeCheckouts()

        // Once, though the sweep keeps trying it.
        expect(errors.mock.calls.filter((args) => JSON.stringify(args).includes(pi))).toHaveLength(1)
    })

    it("skips a run while the last one is still going", async () => {
        const t = await stripeTable()
        await leftAuthorised(t)
        const retrieve = m.retrieveIntent.getMockImplementation()!
        let release!: () => void
        const held = new Promise<void>((resolve) => { release = resolve })
        m.retrieveIntent.mockImplementationOnce(async (id) => {
            await held
            return retrieve(id)
        })

        const first = sweepStripeCheckouts()
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(await sweepStripeCheckouts()).toBeNull()
        release()
        expect(await first).not.toBeNull()
    })
})

// --------------------------------------------------------------------------

describe("the diner hears an outcome their own request didn't answer", () => {
    it("on the table view, with an open cart, and on their next change", async () => {
        const t = await stripeTable({ qty: 3, select: 2 })
        await leftAuthorised(t)
        await sweepStripeCheckouts()

        expect(await t.messages()).toContain(WENT_THROUGH)
        const added = await request(app).post(`/carts/${t.shopId}/tables/${t.tableId}/addItem`).set("Cookie", t.ada.cookies)
            .send({ menuId: t.latte, qty: 1 })
        expect(added.body.notices.map((n: { message: string }) => n.message)).toContain(WENT_THROUGH)
    })

    it("in the 404 body once no cart is open, even when the cart is gone", async () => {
        const t = await stripeTable()
        await leftAuthorised(t)
        await sweepStripeCheckouts()

        const view = await t.view()
        expect(view.status).toBe(404)
        expect(view.body.notices.map((n: { message: string }) => n.message)).toEqual([WENT_THROUGH])

        await CartModel.deleteOne({ _id: t.cartId })
        expect(await t.messages()).toEqual([WENT_THROUGH])
    })

    it("not another diner", async () => {
        const t = await stripeTable()
        await leftAuthorised(t)
        await sweepStripeCheckouts()

        const bob = await authFor("customer")
        expect(await t.messages(bob)).toEqual([])
    })

    it("with the pending text for a processing payment", async () => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)
        fakeStripe.processing(pi)

        await sweepStripeCheckouts()

        expect(await t.messages()).toEqual([BEING_CONFIRMED])
    })

    it("not twice: a reply that gives the outcome doesn't carry its notice, nor does the next view", async () => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)
        await sweepStripeCheckouts()

        const res = await t.capture(pi)

        expect(res.status).toBe(200)
        expect(res.body.notices).toEqual([])
        expect(await t.record(pi)).toMatchObject({ answered: "recorded:completed" })
        expect(await t.messages()).toEqual([])
    })

    it("none after the route answered it", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        expect((await t.capture(pi)).status).toBe(200)

        expect(await t.messages()).toEqual([])
    })

    it("none for an intent never confirmed, even released; shown once it's confirmed, however late", async () => {
        const t = await stripeTable()
        const pi = (await t.create()).body.paymentIntentId
        await setRecord(pi, { createdAt: minutesAgo(61) })
        await sweepStripeCheckouts()
        expect(await t.messages()).toEqual([])

        // A route that lost the claim answered "still confirming" meanwhile.
        await setRecord(pi, { confirmed: true })
        expect(await t.messages()).toEqual([NOT_CHARGED])
    })

    it("that a bank check they started didn't go through, when the sweep cancels it at the hour", async () => {
        const t = await stripeTable()
        const pi = (await t.create()).body.paymentIntentId
        fakeStripe.set(pi, { status: "requires_action" })
        // Ada's capture call: still confirming.
        expect((await t.capture(pi)).status).toBe(502)
        await setRecord(pi, { createdAt: minutesAgo(61) })

        await sweepStripeCheckouts()

        expect(fakeStripe.get(pi).status).toBe("canceled")
        expect(await t.messages()).toEqual([NOT_CHARGED])
    })

    it("not when their own request already gave it, even if the sweep finishes after", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        await heldElsewhere(pi, { expired: true })
        await setRecord(pi, { answered: "recorded:completed", answeredBy: ["their-request"] })

        await sweepStripeCheckouts()

        expect(await t.record(pi)).toMatchObject({ state: "recorded", answered: "recorded:completed", answeredBy: ["their-request"] })
        expect(await t.messages()).toEqual([])
    })

    it("when the capture had won a release they were already told about", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        // Told the release's answer (its cancel failed); the capture had landed.
        fakeStripe.captured(pi)
        await heldElsewhere(pi, { expired: true, state: "releasing" })
        await setRecord(pi, { status: 409, message: "Your selection changed since the order was created, please retry", answered: "released", answeredBy: ["their-request"], confirmed: true })

        await sweepStripeCheckouts()

        expect(await t.record(pi)).toMatchObject({ state: "recorded" })
        expect(await t.messages()).toEqual([WENT_THROUGH])
    })

    it("merged with the cart's notices before they're capped", async () => {
        const t = await stripeTable({ qty: 3, select: 2 })
        const pi = await leftAuthorised(t)
        const older = Array.from({ length: 5 }, (_, i) => ({ at: minutesAgo(30 + i), message: `note ${i}` }))
        await CartModel.updateOne({ _id: t.cartId }, { $push: { notices: { $each: older } } })
        await sweepStripeCheckouts()
        expect(await t.record(pi)).toMatchObject({ state: "recorded" })

        const messages = await t.messages()
        expect(messages).toHaveLength(5)
        expect(messages[0]).toBe(WENT_THROUGH)
    })
})

// --------------------------------------------------------------------------

describe("the manager's payment check of a pending card payment", () => {
    // Recorded as pending by the sweep (Ada had left): her notice says so.
    const pendingCard = async () => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)
        fakeStripe.processing(pi)
        await sweepStripeCheckouts()
        const paymentId = String((await t.cart())!.payments[0]._id)
        const check = () => request(app).post(`/shops/${t.shopId}/carts/${t.cartId}/payments/${paymentId}/check`).set("Cookie", t.owner.cookies)
        const notices = async () => (await t.view()).body.notices as { _id: string; message: string }[]
        return { t, pi, paymentId, check, notices }
    }

    it("tells a diner who was answered \"being confirmed\" when it completes", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        fakeStripe.processing(pi)
        expect((await t.capture(pi)).status).toBe(202)
        expect(await t.messages()).toEqual([])
        const paymentId = (await t.cart())!.payments[0]._id
        fakeStripe.set(pi, { status: "succeeded" })

        await request(app).post(`/shops/${t.shopId}/carts/${t.cartId}/payments/${paymentId}/check`).set("Cookie", t.owner.cookies)

        expect(await t.messages()).toEqual([WENT_THROUGH])
    })

    it("completes it from Stripe, with one new notice (no cart note) under a new id", async () => {
        const { t, pi, check, notices } = await pendingCard()
        const [pending] = await notices()
        expect(pending.message).toBe(BEING_CONFIRMED)
        fakeStripe.set(pi, { status: "succeeded" })

        const res = await check()

        expect(res.status).toBe(200)
        expect(res.body.payment.status).toBe("completed")
        const [done, ...rest] = await notices()
        expect(rest).toEqual([])
        expect(done.message).toBe(WENT_THROUGH)
        expect(done._id).not.toBe(pending._id)
        expect((await t.cart())!.notices).toEqual([])
        expect((await t.cart())!.managerLog.at(-1)).toMatchObject({ action: "checkPayment", byUserId: t.owner.user._id })
    })

    it("keeps the charge id Stripe gives once it's confirmed, so it can be refunded", async () => {
        const t = await stripeTable()
        const pi = await leftAuthorised(t)
        const charge = fakeStripe.get(pi).latest_charge
        fakeStripe.set(pi, { status: "processing", amount_capturable: 0, latest_charge: null })
        await sweepStripeCheckouts()
        const payment = (await t.cart())!.payments[0]
        expect(payment.providerPaymentId).toBeUndefined()
        fakeStripe.set(pi, { status: "succeeded", latest_charge: charge })

        const res = await request(app).post(`/shops/${t.shopId}/carts/${t.cartId}/payments/${payment._id}/check`).set("Cookie", t.owner.cookies)

        expect(res.status).toBe(200)
        expect(res.body.payment).toMatchObject({ status: "completed", providerPaymentId: charge!.id })
    })

    it("fails it when Stripe cancelled it: its items unpaid again, one notice", async () => {
        const { t, pi, check } = await pendingCard()
        fakeStripe.set(pi, { status: "canceled" })

        expect((await check()).status).toBe(200)

        expect((await t.cart())!.items[0].qtyPayed).toBe(0)
        expect(await t.messages()).toEqual([FAILED])
    })

    it("cancels one Stripe sends back for another card before marking it failed, and leaves it pending if it can't", async () => {
        const { t, pi, check } = await pendingCard()
        fakeStripe.set(pi, { status: "requires_payment_method" })
        m.cancelIntent.mockRejectedValueOnce(new Error("socket hang up"))

        expect((await check()).status).toBe(502)
        expect((await t.cart())!.payments[0].status).toBe("pending")

        expect((await check()).status).toBe(200)
        expect(fakeStripe.get(pi).status).toBe("canceled")
        expect((await t.cart())!.payments[0].status).toBe("failed")
    })

    it("doesn't bring a notice back on a second check", async () => {
        const { pi, check, notices } = await pendingCard()
        fakeStripe.set(pi, { status: "succeeded" })
        await check()
        const [first] = await notices()

        expect((await check()).status).toBe(409)
        expect((await notices()).map((n) => n._id)).toEqual([first._id])
    })

    it("repairs a record left behind by a crash before refusing", async () => {
        const { t, pi, check } = await pendingCard()
        fakeStripe.set(pi, { status: "succeeded" })
        await check()
        // The cart saved completed; the record's update never happened.
        await setRecord(pi, { paymentStatus: "pending" })

        const res = await check()

        expect([res.status, res.body.message]).toEqual([409, "This payment isn't awaiting confirmation any more"])
        expect(await t.record(pi)).toMatchObject({ paymentStatus: "completed" })
        expect(await t.messages()).toEqual([WENT_THROUGH])
    })

    it("names Stripe while it's pending", async () => {
        const { t } = await pendingCard()
        const close = await request(app).post(`/shops/${t.shopId}/tables/${t.tableId}/carts/${t.cartId}/close`).set("Cookie", t.owner.cookies)
        expect(close.body.message).toBe("A payment on this table is still awaiting Stripe: check it first")
        // Closed (as deletions.test.ts does), so deletion reaches the money check.
        await CartModel.updateOne({ _id: t.cartId }, { status: "closed" })
        const del = await request(app).delete(`/shops/${t.shopId}/tables/${t.tableId}`).set("Cookie", t.owner.cookies)
        expect(del.body.message).toBe("A payment or refund at this table is still awaiting Stripe — check it first")
    })
})

// --------------------------------------------------------------------------

describe("a manager's refund of a card payment", () => {
    const paidCard = async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        await t.capture(pi)
        const cart = (await t.cart())!
        const paymentId = String(cart.payments[0]._id)
        const refund = () => request(app).post(`/shops/${t.shopId}/carts/${t.cartId}/refunds`).set("Cookie", t.owner.cookies)
            .send({ paymentId, lines: [{ menuId: t.latte, qty: 1 }] })
        return { t, pi, paymentId, refund, charge: cart.payments[0].providerPaymentId! }
    }

    it("refunds the charge in pence, keyed and tagged with the refund's id", async () => {
        const { t, paymentId, refund, charge } = await paidCard()

        const res = await refund()

        expect(res.status).toBe(200)
        const refundId = String(res.body.refund._id)
        expect(m.createRefund).toHaveBeenCalledWith(
            { charge, amount: 300, metadata: { requestId: refundId, cartId: t.cartId, paymentId } },
            refundId
        )
        expect(res.body.refund).toMatchObject({ status: "completed", providerRefundId: expect.stringMatching(/^re_/) })
    })

    it("marks it failed when Stripe refuses it", async () => {
        const { refund } = await paidCard()
        m.createRefund.mockRejectedValueOnce(new stripe.StripeRefundRefused("Your card was closed"))

        const res = await refund()

        expect([res.status, res.body.message]).toEqual([502, "Your card was closed. Nothing was refunded."])
        expect(res.status).toBe(502)
    })

    it("keeps an unclear one in progress, and a retry finds it at Stripe without sending it again", async () => {
        const { t, refund } = await paidCard()
        const create = m.createRefund.getMockImplementation()!
        m.createRefund.mockImplementationOnce(async (params, key) => {
            await create(params, key)
            throw new Error("socket hang up")
        })

        const first = await refund()
        expect(first.status).toBe(502)
        const pending = (await t.cart())!.refunds[0]
        expect(pending.status).toBe("pending")

        const retry = await request(app).post(`/shops/${t.shopId}/carts/${t.cartId}/refunds/${pending._id}/retry`).set("Cookie", t.owner.cookies)

        expect(retry.status).toBe(200)
        expect(retry.body.refund).toMatchObject({ status: "completed", providerRefundId: expect.stringMatching(/^re_/) })
        expect(m.createRefund).toHaveBeenCalledTimes(1)
    })
})
