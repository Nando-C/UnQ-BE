import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals"

// Stripe replaced by the in-memory fake, before the app is imported.
jest.mock("../lib/stripe", () => jest.requireActual<typeof import("./fakeStripe")>("./fakeStripe").stripeMock())

import request from "supertest"
import mongoose from "mongoose"
import "./setup"
import app from "../server"
import * as stripe from "../lib/stripe"
import { authFor } from "./helpers"
import { fakeStripe } from "./fakeStripe"
import { stripeTable, minutesAgo, setRecord, deliver, failedRefund } from "./stripeHelpers"
import CartModel from "../services/carts/model"
import ShopModel from "../services/shops/model"
import UserModel from "../services/users/model"
import StripeCheckoutModel from "../services/carts/stripeCheckout"
import PaybackModel from "../services/payments/payback"
import { stripeTiming, sweepStripeCheckouts } from "../services/carts/stripeFinish"
import { writePayback } from "../services/payments/payback"

// Pay-backs (S35): money staff must give back another way, one record each,
// shown on the table until a manager marks it done.

beforeAll(() => {
    stripeTiming.waitMs = 400
    stripeTiming.pollMs = 50
})
beforeEach(() => fakeStripe.reset())
afterEach(() => { jest.restoreAllMocks() })

type Table = Awaited<ReturnType<typeof stripeTable>>
const quiet = () => jest.spyOn(console, "error").mockImplementation(() => {})
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000)

// Captured, then the cart changed: refunded in full by the finisher (a late
// refund, `late` metadata).
const refundedLate = async (t?: Table) => {
    t ??= await stripeTable()
    const pi = await t.authorised()
    fakeStripe.set(pi, { status: "succeeded", amount_received: 600, amount_capturable: 0 })
    await CartModel.updateOne({ _id: t.cartId }, { $set: { "items.0.qtyPayed": 2 } })
    await deliver("payment_intent.succeeded", fakeStripe.get(pi))
    expect(await t.record(pi)).toMatchObject({ state: "refunded" })
    return { t, pi, refund: fakeStripe.refunds.at(-1)! }
}
// Stripe marks the refund failed for `reason`, and gives the money back to the charge.
const failsAtStripe = (pi: string, refund: Parameters<typeof failedRefund>[0], reason: string | null) => {
    Object.assign(fakeStripe.refunds.find((r) => r.id === refund.id)!, { status: "failed" })
    fakeStripe.get(pi).latest_charge!.amount_refunded = 0
    return deliver("refund.failed", failedRefund(refund, reason))
}
// A late refund handed to staff (a closed card: a new refund would fail too).
const handedOver = async (reason = "expired_or_canceled_card") => {
    const { t, pi, refund } = await refundedLate()
    quiet()
    expect((await failsAtStripe(pi, refund, reason)).status).toBe(200)
    expect(await t.record(pi)).toMatchObject({ state: "refundFailed" })
    return { t, pi, refund }
}

// A manager refunds `qty` lattes of Ada's payment.
const refundLattes = async (t: Table, paymentId: string, qty: number) => {
    const res = await request(app).post(`/shops/${t.shopId}/carts/${t.cartId}/refunds`).set("Cookie", t.owner.cookies)
        .send({ paymentId, lines: [{ menuId: t.latte, qty }], reason: "wrong_item" })
    expect(res.status).toBe(200)
    return { requestId: String(res.body.refund._id), refund: fakeStripe.refunds.at(-1)! }
}
// Ada paid £6 by card for 2 lattes, and a manager refunded `qty` of them.
const managerRefunded = async (qty = 1) => {
    const t = await stripeTable()
    const pi = await t.authorised()
    expect((await t.capture(pi)).status).toBe(200)
    const paymentId = String((await t.cart())!.payments[0]._id)
    return { t, pi, paymentId, ...(await refundLattes(t, paymentId, qty)) }
}

const paybacksOf = (tableId: string) => PaybackModel.find({ tableId }).sort({ at: 1 }).lean()
const sheet = (t: Table, tableId = t.tableId) =>
    request(app).get(`/shops/${t.shopId}/tables/${tableId}/carts`).set("Cookie", t.owner.cookies)
const status = (t: Table) => request(app).get(`/shops/${t.shopId}/tables/status`).set("Cookie", t.owner.cookies)
const markDone = (t: Table, id: string, as: string, who = t.owner) =>
    request(app).post(`/shops/${t.shopId}/paybacks/${id}/done`).set("Cookie", who.cookies).send({ as })

// --------------------------------------------------------------------------

describe("a late refund handed to staff", () => {
    it("is a pay-back, once however often the event or the sweep repeats it", async () => {
        const { t, pi, refund } = await handedOver()

        await deliver("refund.failed", failedRefund(refund))
        await setRecord(pi, { leaseUntil: minutesAgo(1) })
        await sweepStripeCheckouts()

        const paybacks = await paybacksOf(t.tableId)
        expect(paybacks).toHaveLength(1)
        expect(paybacks[0]).toMatchObject({
            kind: "refundRefused", owed: true, amount: 6, currency: "GBP", paymentIntentId: pi,
            tableId: t.tableId, cartId: new mongoose.Types.ObjectId(t.cartId), userId: t.ada.user._id,
            shopId: new mongoose.Types.ObjectId(t.shopId),
        })
        expect(paybacks[0].disputed).toBeUndefined()
        // The log line stays, as the cart's history.
        expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed")).toHaveLength(1)
        expect(await t.record(pi)).toMatchObject({ staffToldAt: expect.any(Date) })
    })

    it("takes a duplicate key wrapped as an error's cause as already written", async () => {
        jest.spyOn(PaybackModel, "create").mockRejectedValueOnce(Object.assign(new Error("write failed"), { cause: { code: 11000 } }))
        const t = await stripeTable()
        await expect(writePayback({
            kind: "refundRefused", shopId: new mongoose.Types.ObjectId(t.shopId), tableId: t.tableId, cartId: new mongoose.Types.ObjectId(t.cartId),
            userId: t.ada.user._id, amount: 6, currency: "GBP", paymentIntentId: "pi_wrapped",
        })).resolves.toBeUndefined()
    })

    it("is marked disputed when Stripe won't refund it for the diner's dispute", async () => {
        const { t } = await handedOver("charge_for_pending_refund_disputed")

        expect((await paybacksOf(t.tableId))[0]).toMatchObject({ kind: "refundRefused", disputed: true })
    })

    it("isn't written once the shop is gone (nowhere to show it): a server error instead", async () => {
        const { t, pi, refund } = await refundedLate()
        await ShopModel.deleteOne({ _id: t.shopId })
        const error = quiet()

        expect((await failsAtStripe(pi, refund, "expired_or_canceled_card")).status).toBe(200)

        expect(await paybacksOf(t.tableId)).toEqual([])
        expect(error.mock.calls.map((c) => c[0])).toContainEqual(expect.stringContaining("no shop left"))
    })

    it("is written even when its cart is gone (closed and deleted before the hand-over)", async () => {
        const { t, pi, refund } = await refundedLate()
        quiet()
        await CartModel.deleteOne({ _id: t.cartId })

        await failsAtStripe(pi, refund, "expired_or_canceled_card")

        expect(await paybacksOf(t.tableId)).toEqual([expect.objectContaining({ kind: "refundRefused", owed: true, shopId: new mongoose.Types.ObjectId(t.shopId) })])
        expect(await t.record(pi)).toMatchObject({ staffToldAt: expect.any(Date) })
    })

    it("is written by the sweep when the first try failed, and staff aren't told twice", async () => {
        const { t, pi, refund } = await refundedLate()
        quiet()
        jest.spyOn(PaybackModel, "create").mockRejectedValueOnce(new Error("database down"))

        expect((await failsAtStripe(pi, refund, "expired_or_canceled_card")).status).toBe(500)
        expect(await paybacksOf(t.tableId)).toEqual([])
        expect((await t.record(pi))!.staffToldAt).toBeUndefined()

        await sweepStripeCheckouts()

        expect(await paybacksOf(t.tableId)).toHaveLength(1)
        expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed")).toHaveLength(1)
    })
})

describe("a manager's card refund Stripe fails later", () => {
    it("is a pay-back when the refund is completed on the cart, once however often Stripe repeats it", async () => {
        const { t, pi, requestId, refund } = await managerRefunded()
        quiet()

        expect((await deliver("refund.failed", failedRefund(refund))).status).toBe(200)
        expect((await deliver("refund.failed", failedRefund(refund))).status).toBe(200)

        expect(await paybacksOf(t.tableId)).toEqual([expect.objectContaining({
            kind: "refundFailed", owed: true, amount: 3, paymentAmount: 6, refundId: new mongoose.Types.ObjectId(requestId), paymentIntentId: pi,
            userId: t.ada.user._id, shopId: new mongoose.Types.ObjectId(t.shopId), cartId: new mongoose.Types.ObjectId(t.cartId),
        })])
        expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed").map((l) => l.details))
            .toEqual([expect.stringMatching(/pay the diner back another way$/)])
    })

    it("two partial refunds of one payment failing are two pay-backs", async () => {
        const first = await managerRefunded(1)
        const second = await refundLattes(first.t, first.paymentId, 1)
        quiet()

        await deliver("refund.failed", failedRefund(first.refund))
        await deliver("refund.failed", failedRefund(second.refund))

        expect((await paybacksOf(first.t.tableId)).map((p) => String(p.refundId))).toEqual([first.requestId, second.requestId])
    })

    it("is marked disputed when the failure is the diner's dispute", async () => {
        const { t, refund } = await managerRefunded()
        quiet()

        await deliver("refund.failed", failedRefund(refund, "charge_for_pending_refund_disputed"))

        expect((await paybacksOf(t.tableId))[0]).toMatchObject({ kind: "refundFailed", disputed: true })
        expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed").map((l) => l.details))
            .toEqual([expect.stringContaining("dispute")])
    })

    it("asks Stripe to send it again while the refund is still pending on the cart, then acts once it's completed", async () => {
        const { t, requestId, refund } = await managerRefunded()
        quiet()
        await CartModel.updateOne({ _id: t.cartId, "refunds._id": requestId }, { $set: { "refunds.$.status": "pending" } })

        expect((await deliver("refund.failed", failedRefund(refund))).status).toBe(500)
        expect(await paybacksOf(t.tableId)).toEqual([])
        expect((await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed")).toEqual([])

        await CartModel.updateOne({ _id: t.cartId, "refunds._id": requestId }, { $set: { "refunds.$.status": "completed" } })
        expect((await deliver("refund.failed", failedRefund(refund))).status).toBe(200)
        expect(await paybacksOf(t.tableId)).toHaveLength(1)
    })

    it("is no pay-back when the refund is already failed on the cart (its items can be refunded again)", async () => {
        const { t, requestId, refund } = await managerRefunded()
        quiet()
        await CartModel.updateOne({ _id: t.cartId, "refunds._id": requestId }, { $set: { "refunds.$.status": "failed" } })

        expect((await deliver("refund.failed", failedRefund(refund))).status).toBe(200)

        expect(await paybacksOf(t.tableId)).toEqual([])
        const lines = (await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed").map((l) => l.details)
        expect(lines).toEqual([expect.stringMatching(/refund those items again$/)])
        expect(lines[0]).not.toMatch(/pay the diner back|retry/)
    })

    it.each([
        ["a refund id that isn't one", { requestId: "not-an-id" }],
        ["a cart id that isn't one", { cartId: "not-an-id" }],
    ])("is no pay-back for %s", async (_, metadata) => {
        const { t, refund } = await managerRefunded()
        const error = quiet()

        const res = await deliver("refund.failed", failedRefund({ ...refund, metadata: { ...refund.metadata, ...metadata } }))

        expect(res.status).toBe(200)
        expect(await paybacksOf(t.tableId)).toEqual([])
        expect(error).toHaveBeenCalled()
    })

    it("still tells the cart's managers when its refund can't be found on the cart", async () => {
        const { t, refund } = await managerRefunded()
        quiet()

        await deliver("refund.failed", failedRefund({ ...refund, metadata: { ...refund.metadata, requestId: "not-an-id" } }))
        await deliver("refund.failed", failedRefund({ ...refund, metadata: { ...refund.metadata, requestId: String(new mongoose.Types.ObjectId()) } }))

        const lines = (await t.cart())!.managerLog.filter((l) => l.action === "stripeRefundFailed").map((l) => l.details)
        expect(lines).toHaveLength(2)
        for (const line of lines) expect(line).toMatch(/isn't on this cart, so check it in Stripe's dashboard$/)
    })
})

// --------------------------------------------------------------------------

describe("the table sheet's pay-backs", () => {
    it("lists the owed ones with the diner's first name, and says when a cart shows the payment as paid", async () => {
        const { t, pi } = await handedOver()

        let res = await sheet(t)
        expect(res.status).toBe(200)
        expect(res.body.paybacks).toEqual([expect.objectContaining({
            kind: "refundRefused", owed: true, amount: 6, paymentIntentId: pi, userId: { _id: String(t.ada.user._id), name: "Test" },
        })])
        expect(res.body.paybacks[0].recorded).toBeUndefined()
        expect(res.body.paybacks[0]).not.toHaveProperty("__v")

        // A stalled holder's save records it on a cart after the hand-over.
        await CartModel.updateOne({ _id: t.cartId }, { $push: { stripePaymentIntentIds: pi } })
        res = await sheet(t)
        expect(res.body.paybacks[0]).toMatchObject({ recorded: true })
    })

    it("keeps done ones for 30 days, with who marked them", async () => {
        const { t } = await handedOver()
        const [owed] = await paybacksOf(t.tableId)
        expect((await markDone(t, String(owed._id), "paidBack")).status).toBe(200)

        let res = await sheet(t)
        expect(res.body.paybacks).toEqual([expect.objectContaining({ doneAs: "paidBack", doneAt: expect.any(String), doneByUserId: { _id: String(t.owner.user._id), name: "Test" } })])
        expect(res.body.paybacks[0].owed).toBeUndefined()

        await PaybackModel.updateOne({ _id: owed._id }, { $set: { doneAt: daysAgo(31) } })
        res = await sheet(t)
        expect(res.body.paybacks).toEqual([])
    })

    it("shows a gone account as null, and a deleted table's pay-backs", async () => {
        const { t } = await handedOver()
        await UserModel.deleteOne({ _id: t.ada.user._id })
        await CartModel.deleteOne({ _id: t.cartId })
        expect((await request(app).delete(`/shops/${t.shopId}/tables/${t.tableId}`).set("Cookie", t.owner.cookies)).status).toBe(204)

        const res = await sheet(t)

        expect(res.status).toBe(200)
        expect(res.body.paybacks).toEqual([expect.objectContaining({ userId: null, owed: true })])
    })

    it("is never in a diner's view", async () => {
        const { t } = await handedOver()

        const res = await request(app).get(`/carts/tables/${t.tableId}`).set("Cookie", t.ada.cookies)

        expect(JSON.stringify(res.body)).not.toMatch(/payback|refundRefused/i)
    })
})

describe("the table card's attention", () => {
    it("flags a table with an owed pay-back until it's marked done", async () => {
        const { t } = await handedOver()

        expect((await status(t)).body[0].attention).toContain("payBack")
        const [owed] = await paybacksOf(t.tableId)
        await markDone(t, String(owed._id), "paidBack")

        expect((await status(t)).body[0].attention).not.toContain("payBack")
    })

    it("lists a deleted table needing attention while a pay-back is owed", async () => {
        const { t } = await handedOver()
        await CartModel.deleteOne({ _id: t.cartId })
        await request(app).delete(`/shops/${t.shopId}/tables/${t.tableId}`).set("Cookie", t.owner.cookies)

        const mine = (await request(app).get("/shops/me").set("Cookie", t.owner.cookies)).body[0]

        expect(mine.deletedTables).toEqual([expect.objectContaining({ _id: t.tableId, needsAttention: true })])
    })
})

// --------------------------------------------------------------------------

describe("marking a pay-back done", () => {
    it("records who, when and as what; logs it on the cart without making it look recently changed", async () => {
        const { t } = await handedOver()
        const [owed] = await paybacksOf(t.tableId)
        const updatedAt = async () => ((await CartModel.collection.findOne({ _id: new mongoose.Types.ObjectId(t.cartId) }))!.updatedAt as Date).getTime()
        const before = await updatedAt()

        const res = await markDone(t, String(owed._id), "paidBack")

        expect(res.status).toBe(200)
        expect(res.body.payback).toMatchObject({ doneAs: "paidBack", doneByUserId: { name: "Test" } })
        const stored = (await PaybackModel.findById(owed._id).lean())!
        expect(stored).toMatchObject({ doneAs: "paidBack", doneByUserId: t.owner.user._id, doneAt: expect.any(Date) })
        expect(stored.owed).toBeUndefined()
        const cart = (await CartModel.findById(t.cartId).lean())!
        expect(cart.managerLog.filter((l) => l.action === "paybackDone").map((l) => l.details))
            .toEqual([`£6.00 marked paid back to Test (payment ${owed.paymentIntentId}; pay-back ${owed._id})`])
        expect(await updatedAt()).toBe(before)
    })

    it.each([
        ["disputed", "handled", async (t: Table, pi: string) => { await PaybackModel.updateOne({ paymentIntentId: pi }, { $set: { disputed: true } }) }],
        ["shown as paid on a cart", "checked", async (t: Table, pi: string) => { await CartModel.updateOne({ _id: t.cartId }, { $push: { stripePaymentIntentIds: pi } }) }],
        ["disputed and shown as paid", "handled", async (t: Table, pi: string) => {
            await PaybackModel.updateOne({ paymentIntentId: pi }, { $set: { disputed: true } })
            await CartModel.updateOne({ _id: t.cartId }, { $push: { stripePaymentIntentIds: pi } })
        }],
    ])("is marked %s as %s, and refused as anything else", async (_, as, make) => {
        const { t, pi } = await handedOver()
        await make(t, pi)
        const [owed] = await paybacksOf(t.tableId)

        const wrong = await markDone(t, String(owed._id), "paidBack")
        expect([wrong.status, wrong.body.message]).toEqual([409, "This pay-back changed: here it is again"])
        expect((await PaybackModel.findById(owed._id).lean())!.owed).toBe(true)

        expect((await markDone(t, String(owed._id), as)).body.payback).toMatchObject({ doneAs: as })
    })

    it("answers one another manager marked first with what they did, whatever was asked", async () => {
        const { t } = await handedOver()
        const [owed] = await paybacksOf(t.tableId)
        const other = await authFor("shopMg")
        await ShopModel.updateOne({ _id: t.shopId }, { $push: { shopMg: other.user._id } })
        await markDone(t, String(owed._id), "paidBack", other)

        const res = await markDone(t, String(owed._id), "checked")

        expect(res.status).toBe(200)
        expect(res.body.payback).toMatchObject({ doneAs: "paidBack", doneByUserId: { _id: String(other.user._id) } })
        expect((await CartModel.findById(t.cartId).lean())!.managerLog.filter((l) => l.action === "paybackDone")).toHaveLength(1)
    })

    it("404s when the pay-back vanished with its shop as it was being marked", async () => {
        const { t } = await handedOver()
        const [owed] = await paybacksOf(t.tableId)
        jest.spyOn(PaybackModel, "findOneAndUpdate").mockImplementationOnce((() => ({
            lean: async () => { await PaybackModel.deleteOne({ _id: owed._id }); return null },
        })) as never)

        const res = await markDone(t, String(owed._id), "paidBack")

        expect(res.status).toBe(404)
    })

    it("writes a line per pay-back, so two alike are two lines", async () => {
        const first = await managerRefunded(1)
        const second = await refundLattes(first.t, first.paymentId, 1)
        quiet()
        await deliver("refund.failed", failedRefund(first.refund))
        await deliver("refund.failed", failedRefund(second.refund))
        const t = first.t

        for (const p of await paybacksOf(t.tableId)) expect((await markDone(t, String(p._id), "paidBack")).status).toBe(200)

        expect((await t.cart())!.managerLog.filter((l) => l.action === "paybackDone")).toHaveLength(2)
        expect(await PaybackModel.countDocuments({ owed: true })).toBe(0)
    })

    it("works with its cart gone (no line), and when the line can't be written", async () => {
        const { t } = await handedOver()
        const [owed] = await paybacksOf(t.tableId)
        await CartModel.deleteOne({ _id: t.cartId })

        expect((await markDone(t, String(owed._id), "paidBack")).status).toBe(200)

        const again = await handedOver()
        const [second] = await paybacksOf(again.t.tableId)
        const error = quiet()
        jest.spyOn(CartModel, "updateOne").mockRejectedValueOnce(new Error("database down"))
        expect((await markDone(again.t, String(second._id), "paidBack")).status).toBe(200)
        expect((await PaybackModel.findById(second._id).lean())!.doneAs).toBe("paidBack")
        expect(error).toHaveBeenCalled()
    })

    it("is for this shop's managers only, and 404s for an unknown, malformed or other shop's id", async () => {
        const { t } = await handedOver()
        const [owed] = await paybacksOf(t.tableId)
        const elsewhere = await stripeTable()

        expect((await markDone(t, String(owed._id), "paidBack", t.ada)).status).toBe(403)
        expect((await request(app).post(`/shops/${elsewhere.shopId}/paybacks/${owed._id}/done`).set("Cookie", elsewhere.owner.cookies).send({ as: "paidBack" })).status).toBe(404)
        expect((await markDone(t, String(new mongoose.Types.ObjectId()), "paidBack")).status).toBe(404)
        expect((await markDone(t, "not-an-id", "paidBack")).status).toBe(404)
        expect((await markDone(t, String(owed._id), "refunded")).status).toBe(400)
        expect((await PaybackModel.findById(owed._id).lean())!.owed).toBe(true)
    })
})

// --------------------------------------------------------------------------

describe("deleting a shop", () => {
    const deleteShop = (t: Table) => request(app).delete(`/shops/${t.shopId}`).set("Cookie", t.owner.cookies)
    // Long enough ago that the sheet's 24-hour refund window is over.
    const aged = async (t: Table, days: number) => {
        await CartModel.collection.updateMany({ _id: new mongoose.Types.ObjectId(t.cartId) }, { $set: { updatedAt: daysAgo(days) } })
        await StripeCheckoutModel.collection.updateMany({ tableId: t.tableId }, { $set: { updatedAt: daysAgo(days) } })
    }

    it("goes ahead for a shop that took card payments but refunded none", async () => {
        const t = await stripeTable({ qty: 2, select: 2 })
        const pi = await t.authorised()
        await t.capture(pi)
        await aged(t, 2)

        expect((await deleteShop(t)).status).toBe(204)
    })

    it("waits 30 days after a manager's card refund, giving the date", async () => {
        const { t } = await managerRefunded(2)
        await aged(t, 29)

        const res = await deleteShop(t)
        expect(res.status).toBe(409)
        expect(res.body.message).toMatch(/^A card refund at this shop on .+ can still fail at Stripe until .+: the shop can be deleted from then$/)

        await aged(t, 31)
        expect((await deleteShop(t)).status).toBe(204)
    })

    it("goes ahead 30 days after a late refund last moved", async () => {
        const { t } = await refundedLate()
        await CartModel.deleteOne({ _id: t.cartId })
        await aged(t, 31)

        expect((await deleteShop(t)).status).toBe(204)
    })

    it("refuses while a late refund moved in the last 30 days (a reopened one counts afresh)", async () => {
        const { t, pi } = await refundedLate()
        await CartModel.deleteOne({ _id: t.cartId })
        await aged(t, 31)
        await setRecord(pi, { updatedAt: daysAgo(3) })

        const res = await deleteShop(t)

        expect(res.status).toBe(409)
        expect(res.body.message).toMatch(/^A card refund at this shop on /)
    })

    it("counts a late refund by a record from before shops were kept on it, its cart gone", async () => {
        const { t, pi } = await refundedLate()
        await CartModel.deleteOne({ _id: t.cartId })
        await aged(t, 3)
        await StripeCheckoutModel.collection.updateOne({ _id: pi as never }, { $unset: { shopId: 1 } })

        const res = await deleteShop(t)

        expect(res.status).toBe(409)
        expect(res.body.message).toMatch(/^A card refund at this shop on /)
    })

    it("dates a manager's refund by the refund, not the cart's last change", async () => {
        const { t } = await managerRefunded(2)
        await aged(t, 2)
        await CartModel.collection.updateMany({ _id: new mongoose.Types.ObjectId(t.cartId) }, { $set: { "refunds.$[].at": daysAgo(31) } })

        expect((await deleteShop(t)).status).toBe(204)
    })

    it("isn't held by a completed refund of a payment that isn't a card one", async () => {
        const t = await stripeTable({ qty: 2, select: 2 })
        const pi = await t.authorised()
        await t.capture(pi)
        await CartModel.updateOne({ _id: t.cartId }, { $push: { refunds: {
            paymentId: new mongoose.Types.ObjectId(), lines: [], amount: 1, currency: "GBP",
            status: "completed", byUserId: new mongoose.Types.ObjectId(), at: new Date(),
        } } })
        await aged(t, 2)

        expect((await deleteShop(t)).status).toBe(204)
    })

    it("refuses while a card payment is still being finished", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        await CartModel.updateOne({ _id: t.cartId }, { $set: { status: "closed" } })
        await setRecord(pi, { state: "finishing" })

        const res = await deleteShop(t)

        expect([res.status, res.body.message]).toEqual([409, "A card payment at Table T1 is still being finished — try again shortly"])
    })

    it("says when it's a refund being retried at Stripe, which can take a day", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        await CartModel.updateOne({ _id: t.cartId }, { $set: { status: "closed" } })
        await setRecord(pi, { state: "finishing", refunding: true })

        const res = await deleteShop(t)

        expect([res.status, res.body.message]).toEqual([409, "A card refund at Table T1 is being retried at Stripe (every 30 minutes, for up to a day) — try again later"])
    })

    it("isn't held by a card payment nobody confirmed (it holds nothing; the sweep cancels it)", async () => {
        const t = await stripeTable()
        expect((await t.create()).status).toBe(200)
        await CartModel.updateOne({ _id: t.cartId }, { $set: { status: "closed" } })

        expect((await deleteShop(t)).status).toBe(204)
    })

    it("refuses while a diner is still to be paid back", async () => {
        const { t } = await handedOver()
        await CartModel.deleteOne({ _id: t.cartId })
        await aged(t, 31)

        const res = await deleteShop(t)

        expect([res.status, res.body.message]).toEqual([409, "A diner at Table T1 is still to be paid back — mark it done first"])
        const [owed] = await paybacksOf(t.tableId)
        await markDone(t, String(owed._id), "paidBack")
        expect((await deleteShop(t)).status).toBe(204)
        // Its pay-backs go with the shop, as its carts do.
        expect(await PaybackModel.countDocuments({ shopId: new mongoose.Types.ObjectId(t.shopId) })).toBe(0)
    })

    it("goes ahead once a hand-over is marked done: its refund already failed, nothing can fail", async () => {
        const { t } = await handedOver()
        await CartModel.deleteOne({ _id: t.cartId })
        const [owed] = await paybacksOf(t.tableId)
        await markDone(t, String(owed._id), "paidBack")

        expect((await deleteShop(t)).status).toBe(204)
    })

    it("goes ahead once a manager's refund that failed at Stripe is marked done", async () => {
        const { t, refund } = await managerRefunded()
        quiet()
        await deliver("refund.failed", failedRefund(refund))
        const [owed] = await paybacksOf(t.tableId)
        await markDone(t, String(owed._id), "paidBack")
        await aged(t, 2)

        expect((await deleteShop(t)).status).toBe(204)
    })

    it("asks for the pay-back first, before the 30 days its refund can still fail", async () => {
        const { t } = await handedOver()
        await CartModel.deleteOne({ _id: t.cartId })

        const res = await deleteShop(t)

        expect([res.status, res.body.message]).toEqual([409, "A diner at Table T1 is still to be paid back — mark it done first"])
    })
})

// --------------------------------------------------------------------------

describe("starting a card payment (createStripeCheckout)", () => {
    it("answers the intent's amount in pence, and records the shop", async () => {
        const t = await stripeTable({ qty: 2, price: 4.1, select: 2 })

        const res = await t.create()

        expect(res.status).toBe(200)
        expect(res.body.amount).toBe(820)
        expect(await t.record(res.body.paymentIntentId)).toMatchObject({ shopId: new mongoose.Types.ObjectId(t.shopId) })
    })

    it("finds the shop of an older cart that doesn't record it, and backfills it", async () => {
        const t = await stripeTable()
        await CartModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(t.cartId) }, { $unset: { shopId: "" } })

        const res = await t.create()

        expect(res.status).toBe(200)
        expect(await t.record(res.body.paymentIntentId)).toMatchObject({ shopId: new mongoose.Types.ObjectId(t.shopId) })
        expect(String((await t.cart())!.shopId)).toBe(t.shopId)
    })

    it("refuses a table no shop has any more, creating nothing", async () => {
        const t = await stripeTable()
        await CartModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(t.cartId) }, { $unset: { shopId: "" } })
        await ShopModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(t.shopId) }, { $set: { tables: [] } })

        const res = await t.create()

        expect([res.status, res.body.message]).toEqual([404, "This table is no longer at a shop"])
        expect(stripe.createIntent).not.toHaveBeenCalled()
    })
})

describe("a card payment whose cart was deleted (reason codes)", () => {
    it("says why in `reason`, from the capture and from a later ask", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        // Recorded by the webhook, then the cart was deleted with its table.
        await deliver("payment_intent.amount_capturable_updated", fakeStripe.get(pi))
        expect(await t.record(pi)).toMatchObject({ state: "recorded" })
        await CartModel.deleteOne({ _id: t.cartId })

        const res = await t.capture(pi)

        expect([res.status, res.body.reason]).toEqual([404, "CART_GONE"])
        expect(res.body.message).toBe("Your card payment went through, but this table's cart is no longer here")
    })

    it("says CART_GONE_PENDING for one being confirmed", async () => {
        const t = await stripeTable()
        const pi = await t.authorised()
        fakeStripe.set(pi, { status: "processing", amount_capturable: 0 })
        await deliver("payment_intent.amount_capturable_updated", fakeStripe.get(pi))
        await CartModel.deleteOne({ _id: t.cartId })

        const res = await t.capture(pi)

        expect([res.status, res.body.reason]).toEqual([404, "CART_GONE_PENDING"])
    })
})
