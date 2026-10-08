import { jest, describe, it, expect } from "@jest/globals"

// Stripe replaced at the module boundary by an in-memory fake, before the app
// is imported (PayPal's client is never reached by these routes).
jest.mock("../lib/stripe", () => jest.requireActual<typeof import("./fakeStripe")>("./fakeStripe").stripeMock())

import "./setup"
import app from "../server"
import UserModel from "../services/users/model"
import mongoose from "mongoose"
import request from "supertest"
import * as stripe from "../lib/stripe"
import { fakeStripe } from "./fakeStripe"
import { stripeTable, heldElsewhere, setRecord, Table, useFakeStripe, WENT_THROUGH } from "./stripeHelpers"
import { quiet } from "./helpers"
import CartModel from "../services/carts/model"
import MenuModel from "../services/menus/model"
import OrderModel from "../services/orders/model"
import StripeCheckoutModel from "../services/carts/stripeCheckout"
import { REFUSED_FOR_MS, sweepStripeCheckouts, takeBackAnswer } from "../services/carts/stripeFinish"

const m = jest.mocked(stripe)
const STILL_CONFIRMING = "STILL_CONFIRMING"

useFakeStripe()

const payments = async (cartId: string) => (await CartModel.findById(cartId))!.payments

// --------------------------------------------------------------------------

describe("createStripeCheckout", () => {
    it("creates a manual-capture intent for the DB-priced total in whole pence, and its record", async () => {
        const t = await stripeTable({ qty: 3, price: 4.1 })

        const res = await t.create()

        expect(res.status).toBe(200)
        const { paymentIntentId, clientSecret } = res.body
        expect(clientSecret).toBe(`${paymentIntentId}_secret_x`)
        expect(m.createIntent).toHaveBeenCalledWith(1230, { cartId: t.cartId, tableId: t.tableId, userId: String(t.ada.user._id) })
        expect(await t.record(paymentIntentId)).toMatchObject({ state: "open", amount: 1230, tableId: t.tableId, confirmed: false })
        expect(await payments(t.cartId)).toHaveLength(0)
    })

    it.each([
        ["nothing is selected", { select: 0 }, async () => {}, 404, "No open split items to pay!"],
        ["an item is sold out", {}, async (t: Awaited<ReturnType<typeof stripeTable>>) => {
            await MenuModel.updateOne({ _id: t.latte }, { available: false })
        }, 409, "Some items you selected are sold out — remove them to pay for the rest"],
        ["the units are taken", { qty: 1, select: 1 }, async (t: Awaited<ReturnType<typeof stripeTable>>) => {
            await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qtyPayed": 1 } })
        }, 409, "Not enough unpaid units left to settle this checkout"],
    ])("is refused, with no intent, when %s", async (_, options, change, status, message) => {
        const t = await stripeTable(options)
        await change(t)

        const res = await t.create()

        expect([res.status, res.body.message]).toEqual([status, message])
        expect(m.createIntent).not.toHaveBeenCalled()
    })

    it("is refused for another table's cart", async () => {
        const t = await stripeTable()
        const other = await stripeTable()

        expect((await t.create(t.ada, other.tableId)).status).toBe(404)
        expect(m.createIntent).not.toHaveBeenCalled()
    })

    it("cancels the intent when its record can't be written", async () => {
        const t = await stripeTable()
        jest.spyOn(StripeCheckoutModel, "create").mockRejectedValueOnce(new Error("database down") as never)

        const res = await t.create()

        expect([res.status, res.body.message]).toEqual([502, "Could not start a card payment"])
        const [pi] = [...fakeStripe.intents.keys()]
        expect(fakeStripe.get(pi).status).toBe("canceled")
    })
})

// --------------------------------------------------------------------------

describe("captureStripeCheckout", () => {
    it("captures, records the payment and its order, closes the splits, and marks the record", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()

        const res = await t.capture(pi)

        expect(res.status).toBe(200)
        expect(res.body.status).toBe("closed")
        expect(res.body.payments).toBeUndefined()
        const cart = await t.cart()
        const charge = fakeStripe.get(pi).latest_charge!.id
        expect(cart!.payments[0]).toMatchObject({
            provider: "stripe", status: "completed", providerCheckoutId: pi, providerPaymentId: charge, currency: "GBP", amount: 6,
        })
        expect(cart!.stripePaymentIntentIds).toEqual([pi])
        expect(cart!.split[0].splitStatus).toBe("closed")
        expect(fakeStripe.get(pi).status).toBe("succeeded")
        expect(await t.record(pi)).toMatchObject({ state: "recorded", paymentStatus: "completed", confirmed: true, answered: "recorded:completed" })
        expect(await OrderModel.findOne({ providerCheckoutId: pi })).toMatchObject({ provider: "stripe", amount: 6 })
    })

    it("charges 3 × £4.10 as 1230 pence and keeps it (not refunded by the re-check)", async () => {
        const t = await stripeTable({ qty: 3, price: 4.1 })
        const pi = await t.authorised()

        expect((await t.capture(pi)).status).toBe(200)
        expect((await payments(t.cartId))[0].amount).toBe(12.3)
        expect(m.createRefund).not.toHaveBeenCalled()
    })

    it("records a processing intent as a pending payment at the intent's amount (202)", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        fakeStripe.processing(pi)

        const res = await t.capture(pi)

        expect(res.status).toBe(202)
        expect((await payments(t.cartId))[0]).toMatchObject({ status: "pending", amount: 6 })
        expect(m.captureIntent).not.toHaveBeenCalled()
        expect(await t.record(pi)).toMatchObject({ state: "recorded", paymentStatus: "pending" })
    })

    describe("cancels the authorisation (nothing charged) when a check fails before capture", () => {
                it.each([
            ["the cart is gone", async (t: Table) => { await CartModel.updateOne({ _id: t.cartId }, { status: "closed" }) }, 404, "Cart Not Found!"],
            ["the diner has no selection", async (t: Table) => { await CartModel.updateOne({ _id: t.cartId }, { $set: { split: [] } }) }, 404, "No open split items to pay!"],
            ["an item sold out", async (t: Table) => { await MenuModel.updateOne({ _id: t.latte }, { available: false }) },
                409, "Some items you selected are sold out — remove them to pay for the rest"],
            ["the units were taken", async (t: Table) => { await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qtyPayed": 1 } }) },
                409, "Not enough unpaid units left to settle this checkout"],
            ["the amount changed", async (t: Table) => {
                await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qty": 3, "split.0.qty": 3 } })
            }, 409, "Your selection changed since the order was created, please retry"],
        ])("when %s, with the same answer to every caller", async (_, change, status, message) => {
            const t = await stripeTable()
            const pi = await t.authorised()
            await change(t)

            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([status, message])
            expect(fakeStripe.get(pi).status).toBe("canceled")
            expect(m.captureIntent).not.toHaveBeenCalled()
            expect(await t.record(pi)).toMatchObject({ state: "released", status, message })
            expect(await payments(t.cartId)).toHaveLength(0)
            // Asked again (a retry, or the webhook later): the stored answer.
            const again = await t.capture(pi)
            expect([again.status, again.body.message]).toEqual([status, message])
        })
    })

    describe("an intent the diner hasn't authorised", () => {
        it("is released and answered 402 when the card was declined or never entered", async () => {
            const t = await stripeTable()
            const pi = (await t.create()).body.paymentIntentId

            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([402, "Payment not completed — nothing was charged"])
            expect(fakeStripe.get(pi).status).toBe("canceled")
            expect(await t.record(pi)).toMatchObject({ state: "released" })
        })

        it("is left open while the bank check is still running (502 still confirming), never cancelled", async () => {
            const t = await stripeTable()
            const pi = (await t.create()).body.paymentIntentId
            fakeStripe.set(pi, { status: "requires_action" })

            const res = await t.capture(pi)

            expect(res.status).toBe(502)
            expect(res.body.reason).toBe(STILL_CONFIRMING)
            expect(res.body.message).toContain(`(payment ${pi})`)
            expect(fakeStripe.get(pi).status).toBe("requires_action")
            const record = await t.record(pi)
            expect(record).toMatchObject({ state: "open", confirmed: true })
            expect(record!.token).toBeUndefined()
            expect(m.cancelIntent).not.toHaveBeenCalled()
        })
    })

    describe("checks the caller against the intent's record first", () => {
        it.each([
            ["another diner's intent", async (t: Awaited<ReturnType<typeof stripeTable>>, pi: string) => {
                const { authFor } = await import("./helpers")
                const bob = await authFor("customer")
                return t.capture(pi, bob)
            }],
            ["an intent of another cart", async (t: Awaited<ReturnType<typeof stripeTable>>, pi: string) => {
                const other = await CartModel.create({ userId: t.ada.user._id, tableId: "elsewhere", status: "closed" })
                return t.capture(pi, t.ada, String(other._id))
            }],
            ["an unknown intent", async (t: Awaited<ReturnType<typeof stripeTable>>) => t.capture("pi_unknown")],
        ])("refusing %s with 402, nothing claimed or cancelled", async (_, call) => {
            const t = await stripeTable()
            const pi = await t.authorised()

            const res = await call(t, pi)

            expect([res.status, res.body.message]).toEqual([402, "This payment was not created for this checkout"])
            expect(res.body.items).toBeUndefined()
            expect(await t.record(pi)).toMatchObject({ state: "open" })
            expect(fakeStripe.get(pi).status).toBe("requires_capture")
            expect(m.retrieveIntent).not.toHaveBeenCalled()
        })
    })

    describe("an intent already on a cart", () => {
        it("answers from the cart's payment: 200, 202 while pending, 402 once failed (the cart closed or not)", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            expect((await t.capture(pi)).status).toBe(200)

            const answeredBy = (await t.record(pi))!.answeredBy
            const again = await t.capture(pi)
            expect(again.status).toBe(200)
            expect(again.body._id).toBe(t.cartId)
            // The same answer, given by both: shared, so the first one's
            // diner leaving wouldn't take back what the second one's read.
            const both = (await t.record(pi))!.answeredBy!
            expect(both).toHaveLength(2)
            expect(both).toEqual(expect.arrayContaining(answeredBy!))
            const second = both.find((stamp) => stamp !== answeredBy![0])!
            await takeBackAnswer(pi, answeredBy![0])
            expect(await t.record(pi)).toMatchObject({ answered: "recorded:completed", answeredBy: [second] })
            await takeBackAnswer(pi, second)
            expect((await t.record(pi))!.answered).toBeUndefined()
            expect(await payments(t.cartId)).toHaveLength(1)

            await CartModel.updateOne({ _id: t.cartId }, { $set: { "payments.0.status": "pending" } })
            expect((await t.capture(pi)).status).toBe(202)
            await CartModel.updateOne({ _id: t.cartId }, { $set: { "payments.0.status": "failed" } })
            const failed = await t.capture(pi)
            expect([failed.status, failed.body.message]).toEqual([402, "This payment didn't go through: nothing was taken"])
            expect(m.captureIntent).toHaveBeenCalledTimes(1)
        })

        it("marks a record left unfinished as recorded, refunding nothing", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            await t.capture(pi)
            // The holder stopped after saving the cart, before marking the record.
            await setRecord(pi, { state: "finishing", leaseUntil: new Date(Date.now() - 1000) })

            await OrderModel.deleteMany({ providerCheckoutId: pi })

            expect((await t.capture(pi)).status).toBe(200)
            expect(await t.record(pi)).toMatchObject({ state: "recorded" })
            expect(m.createRefund).not.toHaveBeenCalled()
            // Its order, which that holder never wrote.
            expect(await OrderModel.findOne({ providerCheckoutId: pi })).toMatchObject({ provider: "stripe" })
        })
    })

    describe("one finisher at a time", () => {
        it("says still confirming, not \"contact staff\", while another holder's refund is in flight", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            await heldElsewhere(pi)
            await setRecord(pi, { refunding: true, status: 409, message: "The table's cart changed while you were paying — your payment was refunded" })

            const res = await t.capture(pi)

            expect([res.status, res.body.reason]).toEqual([502, STILL_CONFIRMING])
        })

        it("waits for a holder with a live lease, then answers 502 still confirming", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            await heldElsewhere(pi)

            const res = await t.capture(pi)

            expect(res.status).toBe(502)
            expect(res.body.reason).toBe(STILL_CONFIRMING)
            expect(m.captureIntent).not.toHaveBeenCalled()
            expect(await t.record(pi)).toMatchObject({ state: "finishing", token: "someone-else", confirmed: true })
        })

        it("claims a record that becomes claimable while it waits, and finishes it", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            await setRecord(pi, { state: "finishing", token: "someone-else", leaseUntil: new Date(Date.now() + 150) })

            expect((await t.capture(pi)).status).toBe(200)
            expect(await t.record(pi)).toMatchObject({ state: "recorded" })
        })

        it("gives a final state's stored answer", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            fakeStripe.set(pi, { status: "canceled" })
            await setRecord(pi, { state: "released", status: 402, message: "Payment not completed — nothing was charged" })

            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([402, "Payment not completed — nothing was charged"])
        })

        it("takes over an expired lease", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            await heldElsewhere(pi, { expired: true })

            expect((await t.capture(pi)).status).toBe(200)
            expect(await payments(t.cartId)).toHaveLength(1)
        })

        it("reads the intent again after claiming: one the last holder captured is settled, not captured twice", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            fakeStripe.captured(pi)
            await heldElsewhere(pi, { expired: true })

            expect((await t.capture(pi)).status).toBe(200)
            expect(m.captureIntent).not.toHaveBeenCalled()
            expect((await payments(t.cartId))[0]).toMatchObject({ provider: "stripe", amount: 6 })
        })

        it("finishes a refund the last holder started, never recording it", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const charge = fakeStripe.get(pi).latest_charge!
            fakeStripe.set(pi, { status: "succeeded", amount_capturable: 0, amount_received: 600, latest_charge: { ...charge, amount_refunded: 100 } })
            await heldElsewhere(pi, { expired: true })

            const res = await t.capture(pi)

            expect(res.status).toBe(409)
            expect(res.body.message).toContain("your payment was refunded")
            expect(fakeStripe.get(pi).latest_charge!.amount_refunded).toBe(600)
            expect(await payments(t.cartId)).toHaveLength(0)
            expect(await t.record(pi)).toMatchObject({ state: "refunded", status: 409 })
        })

        it("says a payment refunded after a release decision was refunded, not that nothing was charged", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const charge = fakeStripe.get(pi).latest_charge!
            // A holder decided to release, the capture won, its refund started, and it stopped.
            fakeStripe.set(pi, { status: "succeeded", amount_capturable: 0, amount_received: 600, latest_charge: { ...charge, amount_refunded: 100 } })
            await setRecord(pi, { state: "releasing", token: "someone-else", leaseUntil: new Date(Date.now() - 1000),
                status: 402, message: "Card payment capture failed — nothing was charged" })

            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([409, "The table's cart changed while you were paying — your payment was refunded"])
            expect(await t.record(pi)).toMatchObject({ state: "refunded", status: 409 })
        })

        it("answers from the cart when marking the record fails after the cart saved", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const updateOne = StripeCheckoutModel.updateOne.bind(StripeCheckoutModel)
            let failed = false
            jest.spyOn(StripeCheckoutModel, "updateOne").mockImplementation(((filter: never, update: { $set?: { state?: string } }) => {
                if (!failed && update?.$set?.state === "recorded" && "token" in (filter as object)) {
                    failed = true
                    return Promise.reject(new Error("connection reset")) as never
                }
                return updateOne(filter, update as never)
            }) as never)

            const res = await t.capture(pi)

            expect(failed).toBe(true)
            expect(res.status).toBe(200)
            expect(await payments(t.cartId)).toHaveLength(1)
            expect(await t.record(pi)).toMatchObject({ state: "recorded", paymentStatus: "completed" })
        })

        it("only completes a release that's under way, even if the checks would now pass", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qty": 3, "split.0.qty": 3 } })
            m.cancelIntent.mockRejectedValueOnce(new Error("timeout"))

            // Nothing can be taken once it's releasing: the release's answer.
            const failed = await t.capture(pi)
            expect([failed.status, failed.body.message]).toEqual([409, "Your selection changed since the order was created, please retry"])
            const releasing = await t.record(pi)
            expect(releasing).toMatchObject({ state: "releasing", status: 409, answered: "released" })
            // Given up at once: the next finisher completes the cancel.
            expect(releasing!.leaseUntil!.getTime()).toBeLessThanOrEqual(Date.now())
            expect(fakeStripe.get(pi).status).toBe("requires_capture")

            // The selection is back as it was.
            await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qty": 2, "split.0.qty": 2 } })
            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([409, "Your selection changed since the order was created, please retry"])
            expect(fakeStripe.get(pi).status).toBe("canceled")
            expect(m.captureIntent).not.toHaveBeenCalled()
            expect(await t.record(pi)).toMatchObject({ state: "released" })
        })

        it("settles a release that lost to a capture, never leaving it releasing", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            fakeStripe.captured(pi)
            await setRecord(pi, { state: "releasing", token: "someone-else", leaseUntil: new Date(Date.now() - 1000), status: 409, message: "x" })

            expect((await t.capture(pi)).status).toBe(200)
            expect(await t.record(pi)).toMatchObject({ state: "recorded" })
        })

        it("stops before saving when its lease was taken over during the capture", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const capture = m.captureIntent.getMockImplementation()!
            m.captureIntent.mockImplementationOnce(async (id, key) => {
                const captured = await capture(id, key)
                await setRecord(pi, { token: "someone-else", leaseUntil: new Date(Date.now() + 60_000) })
                return captured
            })

            const res = await t.capture(pi)

            expect(res.status).toBe(502)
            expect(res.body.reason).toBe(STILL_CONFIRMING)
            expect(await payments(t.cartId)).toHaveLength(0)
            expect(m.createRefund).not.toHaveBeenCalled()
        })
    })

    describe("after it's recorded", () => {
        it("still answers with the cart when the notices can't be read", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            jest.spyOn(StripeCheckoutModel, "find").mockImplementation((() => { throw new Error("connection reset") }) as never)
            quiet()

            const res = await t.capture(pi)

            expect(res.status).toBe(200)
            expect(res.body.notices).toEqual([])
        })

        it("never says it failed when the reply can't be built: still confirming, and the outcome as a notice", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            jest.spyOn(CartModel, "findById").mockImplementationOnce((() => { throw new Error("connection reset") }) as never)
            quiet()

            const res = await t.capture(pi)

            expect([res.status, res.body.reason]).toEqual([502, STILL_CONFIRMING])
            expect(await payments(t.cartId)).toHaveLength(1)
            const record = await t.record(pi)
            expect(record).toMatchObject({ state: "recorded" })
            expect(record!.answered).toBeUndefined()
            expect(await t.messages()).toEqual([WENT_THROUGH])
        })

        it("says it went through when its cart is gone by the time the reply is built", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            jest.spyOn(CartModel, "findById").mockImplementationOnce((() => ({ populate: async () => null })) as never)

            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([404, "Your card payment went through, but this table's cart is no longer here"])
        })

        it("says nothing was taken when asked again about a failed one whose cart was deleted", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            await t.capture(pi)
            await setRecord(pi, { paymentStatus: "failed" })
            await CartModel.deleteOne({ _id: t.cartId })

            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([402, "This payment didn't go through: nothing was taken"])
        })

        it("says it went through when asked again after its cart was deleted", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            await t.capture(pi)
            await CartModel.deleteOne({ _id: t.cartId })

            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([404, "Your card payment went through, but this table's cart is no longer here"])
        })
    })

    describe("a database or Stripe error on the way", () => {
        it("while saving the captured payment: not refunded, the claim given up, and the next finisher records it", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const save = CartModel.prototype.save
            jest.spyOn(CartModel.prototype, "save").mockImplementationOnce(function () {
                return Promise.reject(new Error("not primary"))
            }).mockImplementation(function (this: InstanceType<typeof CartModel>, ...args: unknown[]) {
                return save.apply(this, args as never)
            } as never)
            quiet()

            const res = await t.capture(pi)

            expect([res.status, res.body.reason]).toEqual([502, STILL_CONFIRMING])
            expect(m.createRefund).not.toHaveBeenCalled()
            expect((await t.record(pi))!.leaseUntil!.getTime()).toBeLessThanOrEqual(Date.now())
            expect((await t.capture(pi)).status).toBe(200)
            expect(await payments(t.cartId)).toHaveLength(1)
        })

        it("retries a save that keeps failing for an hour from its first failure, then refunds", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            // Captured late in the intent's life: its hour starts at the first failure.
            await setRecord(pi, { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
            jest.spyOn(CartModel.prototype, "save").mockRejectedValue(new Error("not primary") as never)
            quiet()

            const first = await t.capture(pi)
            expect([first.status, first.body.reason]).toEqual([502, STILL_CONFIRMING])
            expect(m.createRefund).not.toHaveBeenCalled()
            expect(await t.record(pi)).toMatchObject({ settleFailingSince: expect.any(Date) })

            await setRecord(pi, { settleFailingSince: new Date(Date.now() - 61 * 60 * 1000) })
            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([409, "Your payment could not be recorded — your payment was refunded"])
            expect(fakeStripe.get(pi).latest_charge!.amount_refunded).toBe(600)
        })

        it("before anything moved: still confirming, never \"it failed\"", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            m.retrieveIntent.mockRejectedValueOnce(new Error("timeout"))
            quiet()

            const res = await t.capture(pi)

            expect([res.status, res.body.reason]).toEqual([502, STILL_CONFIRMING])
            expect(await t.record(pi)).toMatchObject({ confirmed: true })
        })

        it("never takes back an answer another request gave", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            await setRecord(pi, { answered: "recorded:completed", answeredBy: ["another-request"] })
            m.retrieveIntent.mockRejectedValueOnce(new Error("timeout"))
            quiet()

            expect((await t.capture(pi)).status).toBe(502)
            expect(await t.record(pi)).toMatchObject({ answered: "recorded:completed", answeredBy: ["another-request"] })
        })
    })

    describe("the capture's outcome", () => {
        it("unknown, then succeeded on a second look: recorded", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const capture = m.captureIntent.getMockImplementation()!
            m.captureIntent.mockImplementationOnce(async (id, key) => {
                await capture(id, key)
                throw new Error("socket hang up")
            })

            expect((await t.capture(pi)).status).toBe(200)
            expect(await payments(t.cartId)).toHaveLength(1)
        })

        it("unknown and still unclear: 502 still confirming, the claim given up so the next finisher takes over at once, under its own key", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            m.captureIntent.mockRejectedValueOnce(new Error("socket hang up"))

            const res = await t.capture(pi)

            expect(res.status).toBe(502)
            expect(res.body.reason).toBe(STILL_CONFIRMING)
            const record = await t.record(pi)
            expect(record!.state).toBe("finishing")
            expect(record!.leaseUntil!.getTime()).toBeLessThanOrEqual(Date.now())

            expect((await t.capture(pi)).status).toBe(200)
            const [first, second] = m.captureIntent.mock.calls.map(([, key]) => key)
            expect(first).toMatch(new RegExp(`^capture:${pi}:`))
            expect(second).toMatch(new RegExp(`^capture:${pi}:`))
            expect(second).not.toBe(first)
        })

        it("refused while still awaiting capture: released, 402", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            m.captureIntent.mockRejectedValueOnce(new stripe.StripeCaptureRefused("Your card's issuer declined the capture"))

            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([402, "Card payment capture failed — nothing was charged"])
            expect(fakeStripe.get(pi).status).toBe("canceled")
            expect(await t.record(pi)).toMatchObject({ state: "released" })
        })

        it("refused because it was already captured: recorded", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const capture = m.captureIntent.getMockImplementation()!
            m.captureIntent.mockImplementationOnce(async (id, key) => {
                await capture(id, key)
                throw new stripe.StripeCaptureRefused("This PaymentIntent has already been captured")
            })

            expect((await t.capture(pi)).status).toBe(200)
            expect(await t.record(pi)).toMatchObject({ state: "recorded" })
        })
    })

    describe("a race lost after the capture", () => {
        it("refunds in full, under the claim's key, and records nothing", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const capture = m.captureIntent.getMockImplementation()!
            m.captureIntent.mockImplementationOnce(async (id, key) => {
                const captured = await capture(id, key)
                // Another payer settles the same units in the meantime.
                await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qtyPayed": 2 } })
                return captured
            })

            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([409, "The table's cart changed while you were paying — your payment was refunded"])
            const [[params, key]] = m.createRefund.mock.calls
            expect(params).toEqual({ payment_intent: pi, metadata: { intentId: pi, cartId: t.cartId, late: "true" } })
            expect(key).toMatch(new RegExp(`^late-refund:${pi}:`))
            expect(fakeStripe.get(pi).latest_charge!.amount_refunded).toBe(600)
            expect(await payments(t.cartId)).toHaveLength(0)
            expect(await t.record(pi)).toMatchObject({ state: "refunded", status: 409 })
        })

        it("only completes a refund once decided, even if the cart could take the payment by then", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const capture = m.captureIntent.getMockImplementation()!
            m.captureIntent.mockImplementationOnce(async (id, key) => {
                const captured = await capture(id, key)
                await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qtyPayed": 2 } })
                return captured
            })
            m.createRefund.mockRejectedValueOnce(new Error("socket hang up"))
            quiet()

            const unclear = await t.capture(pi)
            expect([unclear.status, unclear.body.message]).toEqual([500, `Payment captured but could not be recorded or refunded — please contact staff (payment ${pi})`])
            const record = await t.record(pi)
            expect(record).toMatchObject({ state: "finishing", refunding: true })
            expect(record!.leaseUntil!.getTime()).toBeLessThanOrEqual(Date.now())

            // The units are free again; the next finisher still refunds.
            await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qtyPayed": 0 } })
            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([409, "The table's cart changed while you were paying — your payment was refunded"])
            expect(fakeStripe.get(pi).latest_charge!.amount_refunded).toBe(600)
            expect(await payments(t.cartId)).toHaveLength(0)
        })

        it("backs off from refunding one the cart check marked recorded meanwhile", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const capture = m.captureIntent.getMockImplementation()!
            m.captureIntent.mockImplementationOnce(async (id, key) => {
                const captured = await capture(id, key)
                await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qtyPayed": 2 } })
                return captured
            })
            // Just before the refund is decided, a stalled holder's save lands
            // and the diner's other request marks the record recorded from it.
            const updateOne = StripeCheckoutModel.updateOne.bind(StripeCheckoutModel)
            jest.spyOn(StripeCheckoutModel, "updateOne").mockImplementation((async (filter: never, update: { $set?: { refunding?: boolean } }) => {
                if (update?.$set?.refunding) {
                    await CartModel.updateOne({ _id: t.cartId }, { $set: { stripePaymentIntentIds: [pi] } })
                    await setRecord(pi, { state: "recorded", paymentStatus: "completed" })
                }
                return updateOne(filter, update as never)
            }) as never)

            const res = await t.capture(pi)

            expect(res.status).toBe(200)
            expect(m.createRefund).not.toHaveBeenCalled()
            expect(await t.record(pi)).toMatchObject({ state: "recorded" })
            expect((await t.record(pi))!.refunding).toBeUndefined()
        })

        it("reports an intent found on a cart after it was refunded", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const capture = m.captureIntent.getMockImplementation()!
            m.captureIntent.mockImplementationOnce(async (id, key) => {
                const captured = await capture(id, key)
                await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qtyPayed": 2 } })
                return captured
            })
            const refund = m.createRefund.getMockImplementation()!
            m.createRefund.mockImplementationOnce(async (params, key) => {
                const done = await refund(params, key)
                // A holder that stalled past its lease saved it meanwhile.
                await CartModel.updateOne({ _id: t.cartId }, { $set: { stripePaymentIntentIds: [pi] } })
                return done
            })
            const errors = quiet()

            await t.capture(pi)

            expect(errors.mock.calls.some(([message]) => String(message).includes("recorded, but refunded"))).toBe(true)
            expect((await t.cart())!.managerLog.at(-1)).toMatchObject({ action: "stripeRefundedRecorded" })
            // Asked again, it's still refunded: the money is back with the diner.
            const again = await t.capture(pi)
            expect([again.status, again.body.message]).toEqual([409, "The table's cart changed while you were paying — your payment was refunded"])
            expect(await t.record(pi)).toMatchObject({ state: "refunded" })
            expect(await t.messages()).toEqual([])
        })

        it("completes a refund once decided even if a stalled holder put it on a cart, and tells the manager", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            fakeStripe.captured(pi)
            await heldElsewhere(pi, { expired: true })
            await setRecord(pi, { refunding: true, status: 409, message: "The table's cart changed while you were paying — your payment was refunded" })
            await CartModel.updateOne({ _id: t.cartId }, { $set: { stripePaymentIntentIds: [pi] } })
            quiet()

            const res = await t.capture(pi)

            expect(res.status).toBe(409)
            expect(fakeStripe.get(pi).latest_charge!.amount_refunded).toBe(600)
            expect(await t.record(pi)).toMatchObject({ state: "refunded" })
            expect((await t.cart())!.managerLog.at(-1)).toMatchObject({ action: "stripeRefundedRecorded" })
        })

        it("takes a refund staff made by hand as done", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const charge = fakeStripe.get(pi).latest_charge!
            fakeStripe.set(pi, { status: "succeeded", amount_capturable: 0, amount_received: 600, latest_charge: { ...charge, amount_refunded: 600 } })
            await heldElsewhere(pi, { expired: true })
            await setRecord(pi, { refunding: true, status: 409, message: "The table's cart changed while you were paying — your payment was refunded" })

            const res = await t.capture(pi)

            expect([res.status, res.body.message]).toEqual([409, "The table's cart changed while you were paying — your payment was refunded"])
            expect(await t.record(pi)).toMatchObject({ state: "refunded" })
        })

        it("tries a late refund Stripe refused again in half an hour, not at once", async () => {
            const t = await stripeTable()
            const pi = await t.authorised()
            const capture = m.captureIntent.getMockImplementation()!
            m.captureIntent.mockImplementationOnce(async (id, key) => {
                const captured = await capture(id, key)
                await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qtyPayed": 2 } })
                return captured
            })
            m.createRefund.mockRejectedValueOnce(new stripe.StripeRefundRefused("Insufficient funds in Stripe account", "balance_insufficient"))
            quiet()

            const res = await t.capture(pi)

            expect(res.status).toBe(500)
            const record = await t.record(pi)
            expect(record).toMatchObject({ state: "finishing", refunding: true })
            expect(record!.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 25 * 60 * 1000)
            // Asked meanwhile: the same answer, not "still confirming".
            const meanwhile = await t.capture(pi)
            expect([meanwhile.status, meanwhile.body.message]).toEqual([500, res.body.message])
            // Half an hour later, the next finisher refunds it.
            await setRecord(pi, { leaseUntil: new Date(Date.now() - 1000) })
            expect((await t.capture(pi)).status).toBe(409)
            expect(fakeStripe.get(pi).latest_charge!.amount_refunded).toBe(600)
        })

        describe("a late refund Stripe keeps refusing", () => {
            const NOT_REFUNDED = (pi: string) => `Payment captured but could not be recorded or refunded — please contact staff (payment ${pi})`
            const HANDED_OVER = (pi: string) =>
                `£6.00 card payment by Test: Stripe won't refund it, so they were charged (payment ${pi}). ` +
                "Pay them back another way, unless a cart shows this payment as paid and they didn't pay again, " +
                "or Stripe's dashboard shows they've disputed it since (their bank returns it then)."
            const refused = (code: string) => new stripe.StripeRefundRefused(`Stripe didn't make the refund (${code})`, code)
            const staffLines = async (t: Awaited<ReturnType<typeof stripeTable>>) =>
                (await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed").map((l) => l.details)
            // Captured, then the cart changed under it: refunded, and Stripe
            // refuses that refund once (`code`).
            const refusedOnce = async (code: string) => {
                const t = await stripeTable()
                const pi = await t.authorised()
                const capture = m.captureIntent.getMockImplementation()!
                m.captureIntent.mockImplementationOnce(async (id, key) => {
                    const captured = await capture(id, key)
                    await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qtyPayed": 2 } })
                    return captured
                })
                m.createRefund.mockRejectedValueOnce(refused(code))
                quiet()
                const res = await t.capture(pi)
                expect([res.status, res.body.message]).toEqual([500, ["charge_disputed", "refund_disputed_payment"].includes(code)
                    ? `Payment captured but couldn't be refunded to your card while you dispute it: your bank returns it (payment ${pi})`
                    : NOT_REFUNDED(pi)])
                return { t, pi }
            }
            // Its retry time come, as the sweep finds it.
            const retried = async (pi: string) => {
                await setRecord(pi, { leaseUntil: new Date(Date.now() - 1000) })
                return sweepStripeCheckouts()
            }

            it("is handed to staff at once when a new refund would fail too (the card's closed)", async () => {
                const { t, pi } = await refusedOnce("expired_or_canceled_card")

                expect(await t.record(pi)).toMatchObject({ state: "refundFailed", refunding: true })
                expect(await staffLines(t)).toEqual([HANDED_OVER(pi)])
                // Final: never refunded again; asked again, the same answer.
                await retried(pi)
                expect(m.createRefund).toHaveBeenCalledTimes(1)
                const again = await t.capture(pi)
                expect([again.status, again.body.message]).toEqual([500, NOT_REFUNDED(pi)])
                // The diner had the answer: no notice of it too.
                expect(await t.messages()).toEqual([])
            })

            it("is tried again for a day from its first refusal, then handed to staff", async () => {
                const { t, pi } = await refusedOnce("balance_insufficient")
                const first = (await t.record(pi))!.refundRefusedSince!
                expect(first).toBeInstanceOf(Date)

                // Refused again within the day: tried again later, the clock kept.
                m.createRefund.mockRejectedValueOnce(refused("balance_insufficient"))
                await retried(pi)
                const later = (await t.record(pi))!
                expect(later).toMatchObject({ state: "finishing", refundRefusedSince: first })
                expect(later.refundRetryAt!.getTime()).toBeGreaterThan(Date.now() + 25 * 60 * 1000)

                // A day on.
                await setRecord(pi, { refundRefusedSince: new Date(Date.now() - REFUSED_FOR_MS - 1000) })
                m.createRefund.mockRejectedValueOnce(refused("balance_insufficient"))
                expect(await retried(pi)).toMatchObject({ handedOver: 1, left: 0 })

                const record = (await t.record(pi))!
                expect(record.state).toBe("refundFailed")
                expect(record.refundRetryAt).toBeUndefined()
                expect(await staffLines(t)).toEqual([HANDED_OVER(pi)])
                expect(await t.messages()).toEqual([
                    `Your card payment of £6.00 couldn't be refunded to your card: please contact staff about it (payment ${pi})`,
                ])
            })

            it("starts the clock again once a refund goes through", async () => {
                const { t, pi } = await refusedOnce("balance_insufficient")

                await retried(pi)

                const record = (await t.record(pi))!
                expect(record.state).toBe("refunded")
                expect(record.refundRefusedSince).toBeUndefined()
                expect(await staffLines(t)).toEqual([])
            })

            it.each(["charge_not_refundable", "canceled"])("is handed to staff at once when refused outright as %s", async (code) => {
                const { t, pi } = await refusedOnce(code)

                expect(await t.record(pi)).toMatchObject({ state: "refundFailed", refundOwed: 600 })
                expect(await staffLines(t)).toEqual([HANDED_OVER(pi)])
            })

            it.each(["charge_disputed", "refund_disputed_payment"])("is handed over as disputed when refused outright as %s: staff don't pay back", async (code) => {
                const { t, pi } = await refusedOnce(code)
                // Asked again, the diner hears their bank returns it.
                const again = await t.capture(pi)
                expect([again.status, again.body.message]).toEqual([
                    500, `Payment captured but couldn't be refunded to your card while you dispute it: your bank returns it (payment ${pi})`,
                ])

                expect(await t.record(pi)).toMatchObject({ state: "refundFailed", disputed: true })
                expect(await staffLines(t)).toEqual([
                    `£6.00 card payment by Test is disputed with their bank, so Stripe won't refund it (payment ${pi}). ` +
                    "Don't pay them back yourselves: accept the dispute in Stripe's dashboard (don't contest it), and their bank returns the money. " +
                    "If it closes without the money going back to them, pay them back another way.",
                ])
            })

            it("isn't taken as disputed from the charge's flag, which stays once a dispute closes", async () => {
                const { t, pi } = await refusedOnce("balance_insufficient")
                Object.assign(fakeStripe.get(pi).latest_charge!, { disputed: true })
                await setRecord(pi, { refundRefusedSince: new Date(Date.now() - REFUSED_FOR_MS - 1000) })
                m.createRefund.mockRejectedValueOnce(refused("balance_insufficient"))

                await retried(pi)

                const record = (await t.record(pi))!
                expect(record.state).toBe("refundFailed")
                expect(record.disputed).toBeUndefined()
                expect(await staffLines(t)).toEqual([HANDED_OVER(pi)])
            })

            it("is refunded, not handed over, when staff refunded it in full by hand meanwhile", async () => {
                const { t, pi } = await refusedOnce("balance_insufficient")
                await stripe.createRefund({ payment_intent: pi, metadata: {} }, "by-hand")
                m.createRefund.mockRejectedValueOnce(refused("canceled"))

                await retried(pi)

                const record = (await t.record(pi))!
                expect(record.state).toBe("refunded")
                expect(record.refundRefusedSince).toBeUndefined()
                expect(await staffLines(t)).toEqual([])
            })

            it("isn't handed over while Stripe can't be asked what's still taken: tried again", async () => {
                const { t, pi } = await refusedOnce("balance_insufficient")
                const retrieve = m.retrieveIntent.getMockImplementation()!
                m.retrieveIntent.mockImplementationOnce(retrieve).mockRejectedValueOnce(new Error("Stripe down"))
                m.createRefund.mockRejectedValueOnce(refused("canceled"))

                await retried(pi)
                expect((await t.record(pi))!.state).toBe("finishing")
                expect(await staffLines(t)).toEqual([])

                m.createRefund.mockRejectedValueOnce(refused("canceled"))
                await retried(pi)
                expect(await t.record(pi)).toMatchObject({ state: "refundFailed", refundOwed: 600 })
            })

            it("names a diner with no name as such", async () => {
                const { t, pi } = await refusedOnce("balance_insufficient")
                await UserModel.collection.updateOne({ _id: (await t.record(pi))!.userId }, { $set: { name: "" } })
                m.createRefund.mockRejectedValueOnce(refused("canceled"))

                await retried(pi)

                expect(await staffLines(t)).toEqual([expect.stringMatching(/^£6\.00 card payment by a diner with no name: /)])
            })

            it("tells staff on the next sweep when they couldn't be told, never refunding it again", async () => {
                const { t, pi } = await refusedOnce("balance_insufficient")
                await setRecord(pi, { refundRefusedSince: new Date(Date.now() - REFUSED_FOR_MS - 1000) })
                m.createRefund.mockRejectedValueOnce(refused("balance_insufficient"))
                // Down for the hand-over, and for the same sweep's own try.
                jest.spyOn(CartModel, "updateOne").mockRejectedValueOnce(new Error("database down")).mockRejectedValueOnce(new Error("database down"))

                expect(await retried(pi)).toMatchObject({ handedOver: 1, failed: 1 })
                const record = (await t.record(pi))!
                expect(record.state).toBe("refundFailed")
                expect(record.staffToldAt).toBeUndefined()
                expect(await staffLines(t)).toEqual([])

                await sweepStripeCheckouts()
                expect(await staffLines(t)).toEqual([HANDED_OVER(pi)])
                expect((await t.record(pi))!.staffToldAt).toBeInstanceOf(Date)
                // Told: a later sweep doesn't tell them again.
                await sweepStripeCheckouts()
                expect(await staffLines(t)).toHaveLength(1)
                expect(m.createRefund).toHaveBeenCalledTimes(2)
            })

            it("tells staff in the same words when a stalled finisher recorded it on the cart (they check it)", async () => {
                const { t, pi } = await refusedOnce("balance_insufficient")
                await CartModel.updateOne({ _id: t.cartId }, { $push: { stripePaymentIntentIds: pi } })
                m.createRefund.mockRejectedValueOnce(refused("canceled"))

                await retried(pi)

                expect((await t.record(pi))!.state).toBe("refundFailed")
                expect(await staffLines(t)).toEqual([HANDED_OVER(pi)])
            })

            it("is never answered as recorded, even on a cart and without its refunding mark", async () => {
                const { t, pi } = await refusedOnce("canceled")
                await StripeCheckoutModel.collection.updateOne({ _id: pi as never }, { $unset: { refunding: 1 } })
                await CartModel.updateOne({ _id: t.cartId }, { $push: { stripePaymentIntentIds: pi } })

                const res = await t.capture(pi)

                expect([res.status, res.body.message]).toEqual([500, NOT_REFUNDED(pi)])
                expect((await t.record(pi))!.state).toBe("refundFailed")
            })

            it("names a diner whose account is gone as such", async () => {
                const { t, pi } = await refusedOnce("balance_insufficient")
                await UserModel.deleteOne({ _id: (await t.record(pi))!.userId })
                m.createRefund.mockRejectedValueOnce(refused("canceled"))

                await retried(pi)

                expect(await staffLines(t)).toEqual([expect.stringMatching(/^£6\.00 card payment by a diner whose account is gone: /)])
            })

            it("lists the table's closed cart again for a day, with the line on it", async () => {
                const { t, pi } = await refusedOnce("balance_insufficient")
                const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
                await CartModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(t.cartId) }, { $set: { status: "closed", updatedAt: twoDaysAgo } })
                const listed = async () => (await request(app).get(`/shops/${t.shopId}/tables/${t.tableId}/carts`).set("Cookie", t.owner.cookies))
                    .body.recentlyClosed.map((c: { _id: string }) => c._id)
                expect(await listed()).toEqual([])
                m.createRefund.mockRejectedValueOnce(refused("canceled"))

                await retried(pi)

                expect(await listed()).toEqual([t.cartId])
                expect(await staffLines(t)).toEqual([HANDED_OVER(pi)])
            })

            it("says so as a server error when its cart is gone, and stops telling", async () => {
                const { pi } = await refusedOnce("balance_insufficient")
                const record = (await StripeCheckoutModel.findById(pi).lean())!
                await CartModel.deleteOne({ _id: record.cartId })
                const error = quiet()
                m.createRefund.mockRejectedValueOnce(refused("expired_or_canceled_card"))

                await retried(pi)

                expect(error).toHaveBeenCalledWith(expect.stringContaining("no cart left to tell staff on"), expect.objectContaining({ paymentIntentId: pi }))
                expect(await StripeCheckoutModel.findById(pi).lean()).toMatchObject({ state: "refundFailed", staffToldAt: expect.any(Date) })
            })
        })
    })
})
