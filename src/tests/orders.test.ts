import { jest, describe, it, expect, beforeEach } from "@jest/globals"

// PayPal mocked at the module boundary, before the app is imported.
jest.mock("../lib/paypal", () => ({
    getOrder: jest.fn(),
    createOrder: jest.fn(),
    captureOrder: jest.fn(),
    refundCapture: jest.fn(),
    findRefund: jest.fn(),
    PayPalRefundRefused: jest.requireActual<typeof import("../lib/paypal")>("../lib/paypal").PayPalRefundRefused,
    PayPalCaptureRefused: jest.requireActual<typeof import("../lib/paypal")>("../lib/paypal").PayPalCaptureRefused,
}))

import request from "supertest"
import mongoose from "mongoose"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"
import CartModel, { REFUND_REASONS } from "../services/carts/model"
import MenuModel from "../services/menus/model"
import ShopModel from "../services/shops/model"
import OrderModel from "../services/orders/model"
import { syncOrder, syncAllOrders } from "../services/orders/sync"
import { getOrder, captureOrder, refundCapture, PayPalOrder, PayPalRefundRefused } from "../lib/paypal"
import * as mongoLib from "../lib/mongo"

const mockedGetOrder = jest.mocked(getOrder)
const mockedCapture = jest.mocked(captureOrder)
const mockedRefund = jest.mocked(refundCapture)

beforeEach(() => {
    mockedGetOrder.mockReset()
    mockedCapture.mockReset()
    mockedRefund.mockReset()
    mockedRefund.mockResolvedValue("REF-1")
})

// The order as PayPal shows it, its capture in `captureStatus`. Each payment
// in a test has its own PayPal order (checkout refuses one used before).
let orders = 0
const orderWith = (captureStatus: string, n = orders, value = "6.00"): PayPalOrder => ({
    id: `ORDER-${n}`,
    status: "COMPLETED",
    purchase_units: [{
        amount: { currency_code: "GBP", value },
        payments: { captures: [{ id: `CAP-${n}`, status: captureStatus, amount: { currency_code: "GBP", value } }] },
    }],
})

// Ada orders 2 £3 Lattes (drinks) at table T1 and pays for both through PayPal,
// which answers the capture with `captureStatus`.
const paid = async ({ captureStatus = "COMPLETED" } = {}) => {
    const owner = await authFor("shopMg")
    const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id as string
    const tableId = (await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name: "T1" })).body._id as string
    const latte = (await request(app).post(`/shops/${shopId}/menu`).set("Cookie", owner.cookies)
        .send({ name: "Latte", short_description: "x", price: 3, category: "drinks" })).body._id as string
    const ada = await authFor("customer")
    const cartId = (await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", ada.cookies)
        .send({ menuId: latte, qty: 2 })).body._id as string
    await request(app).post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`).set("Cookie", ada.cookies)
        .send({ menuId: latte, qty: 2 })

    const n = ++orders
    mockedGetOrder.mockResolvedValueOnce({
        id: `ORDER-${n}`, status: "APPROVED",
        purchase_units: [{ amount: { currency_code: "GBP", value: "6.00" }, custom_id: `${cartId}:${ada.user._id}` }],
    })
    mockedCapture.mockResolvedValueOnce(orderWith(captureStatus, n))
    const checkout = await request(app).post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
        .set("Cookie", ada.cookies).send({ paypalOrderId: `ORDER-${n}` })

    const paymentId = String((await CartModel.findById(cartId))!.payments[0]._id)
    // PayPal's answer when the payment is checked.
    const check = (captureStatus: string) => mockedGetOrder.mockResolvedValueOnce(orderWith(captureStatus, n)) && request(app).post(`/shops/${shopId}/carts/${cartId}/payments/${paymentId}/check`).set("Cookie", owner.cookies)
    const refund = (body: Record<string, unknown> = {}) =>
        request(app).post(`/shops/${shopId}/carts/${cartId}/refunds`).set("Cookie", owner.cookies)
            .send({ paymentId, lines: [{ menuId: latte, qty: 1 }], reason: "wrong_item", ...body })
    const order = () => OrderModel.findOne({ paymentId }).lean()
    // syncOrder from the cart as it is now.
    const resync = async () => syncOrder((await CartModel.findById(cartId))!, paymentId)
    return { owner, shopId, tableId, latte, ada, cartId, paymentId, checkout, check, refund, order, resync }
}

// Closed three days ago, so nothing on it holds its shop back.
const closedLongAgo = (cartId: string) => CartModel.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(cartId) },
    { $set: { status: "closed", updatedAt: new Date(Date.now() - 3 * 86_400_000) } }
)

// `send` with the first version-checked save going through (the pending
// refund) and every later one meeting a newer cart, quietly.
const withRecordingFailing = async <T>(send: () => Promise<T>) => {
    const real = mongoLib.saveChecked
    const save = jest.spyOn(mongoLib, "saveChecked").mockImplementationOnce(real).mockResolvedValue(false)
    const quiet = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
        return await send()
    } finally {
        save.mockRestore()
        quiet.mockRestore()
    }
}

describe("an order per payment", () => {
    it("is written at checkout with what the sales report needs", async () => {
        const { shopId, tableId, latte, ada, cartId, paymentId, checkout, order } = await paid()
        expect(checkout.status).toBe(200)
        const cart = (await CartModel.findById(cartId))!
        expect(cart.payments[0].lines[0]).toMatchObject({ name: "Latte", category: "drinks" })

        expect(await OrderModel.countDocuments()).toBe(1)
        expect(await order()).toMatchObject({
            paymentId: new mongoose.Types.ObjectId(paymentId),
            cartId: new mongoose.Types.ObjectId(cartId),
            shopId: new mongoose.Types.ObjectId(shopId),
            tableId,
            tableName: "T1",
            cartOpenedAt: (cart as unknown as { createdAt: Date }).createdAt,
            payerId: ada.user._id,
            status: "completed",
            paidAt: cart.payments[0].paidAt,
            currency: "GBP",
            amount: 6,
            provider: "paypal",
            providerCheckoutId: `ORDER-${orders}`,
            providerPaymentId: `CAP-${orders}`,
            lines: [{ menuId: new mongoose.Types.ObjectId(latte), name: "Latte", category: "drinks", unitPrice: 3, qty: 2, refundedQty: 0 }],
            refunds: [],
        })
    })

    it("follows the payment's status: pending, then confirmed or failed", async () => {
        const held = await paid({ captureStatus: "PENDING" })
        expect((await held.order())?.status).toBe("pending")
        expect((await held.check("COMPLETED")).status).toBe(200)
        expect((await held.order())?.status).toBe("completed")

        const refused = await paid({ captureStatus: "PENDING" })
        expect((await refused.check("DECLINED")).status).toBe(200)
        expect((await refused.order())?.status).toBe("failed")
    })

    it("records each refund with its date, lines, money and reason", async () => {
        const { latte, refund, order } = await paid()
        expect((await refund({ reason: "other", reasonNote: "  Spilled at the table  " })).status).toBe(200)

        const kept = (await order())!
        expect(kept.lines[0].refundedQty).toBe(1)
        expect(kept.refunds).toEqual([expect.objectContaining({
            status: "completed",
            amount: 3,
            lines: [{ menuId: new mongoose.Types.ObjectId(latte), name: "Latte", qty: 1 }],
            reason: "other",
            reasonNote: "Spilled at the table",
        })])
        expect(kept.refunds[0].at).toBeInstanceOf(Date)
    })

    it("records a refund PayPal refused as failed, and one it didn't answer as pending", async () => {
        const refused = await paid()
        mockedRefund.mockRejectedValueOnce(new PayPalRefundRefused("PayPal refused the refund"))
        expect((await refused.refund()).status).toBe(502)
        expect((await refused.order())?.refunds).toEqual([expect.objectContaining({ status: "failed", reason: "wrong_item" })])
        expect((await refused.order())?.lines[0].refundedQty).toBe(0)

        const unclear = await paid()
        mockedRefund.mockRejectedValueOnce(new Error("timeout"))
        expect((await unclear.refund()).status).toBe(502)
        expect((await unclear.order())?.refunds).toEqual([expect.objectContaining({ status: "pending" })])
    })

    it("shows a refund PayPal made but that couldn't be recorded as in progress", async () => {
        const { refund, order } = await paid()
        // The pending refund saves; recording PayPal's success then keeps
        // meeting newer versions of the cart.
        expect((await withRecordingFailing(refund)).status).toBe(500)
        expect((await order())?.refunds).toEqual([expect.objectContaining({ status: "pending", reason: "wrong_item" })])
    })

    it("shows a refund PayPal refused but that couldn't be marked failed as in progress", async () => {
        const { refund, order } = await paid()
        mockedRefund.mockRejectedValueOnce(new PayPalRefundRefused("PayPal refused the refund"))
        expect((await withRecordingFailing(refund)).status).toBe(502)
        expect((await order())?.refunds).toEqual([expect.objectContaining({ status: "pending" })])
    })

    it("keeps the table's name and the item's category as they were when paid", async () => {
        const { owner, shopId, tableId, latte, refund, order } = await paid()
        await request(app).put(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies).send({ name: "Garden" })
        await MenuModel.updateOne({ _id: latte }, { category: "food" })

        expect((await refund()).status).toBe(200)
        expect(await order()).toMatchObject({ tableName: "T1", lines: [expect.objectContaining({ category: "drinks" })] })
    })

    it("doesn't fail a checkout when its order can't be written; the repair writes it", async () => {
        const write = jest.spyOn(OrderModel, "updateOne").mockRejectedValueOnce(new Error("database blip"))
        const quiet = jest.spyOn(console, "error").mockImplementation(() => {})
        const { checkout, order } = await paid()
        write.mockRestore()

        expect(checkout.status).toBe(200)
        expect(quiet).toHaveBeenCalled()
        quiet.mockRestore()
        expect(await order()).toBeNull()
        await syncAllOrders()
        expect((await order())?.status).toBe("completed")
    })
})

describe("syncOrder", () => {
    // The payment's line as if paid before categories were kept, and no order yet.
    const forgetCategory = async (cartId: string) => {
        await CartModel.updateOne({ _id: cartId }, { $unset: { "payments.0.lines.0.category": 1 } })
        await OrderModel.deleteMany({})
    }

    it("never doubles an order, and an older cart never overwrites a newer one's", async () => {
        const { cartId, paymentId, refund, order } = await paid()
        const before = (await CartModel.findById(cartId))!
        await syncOrder(before, paymentId)
        expect(await OrderModel.countDocuments({ paymentId })).toBe(1)

        expect((await refund()).status).toBe(200)
        await syncOrder(before, paymentId)
        expect((await order())?.refunds).toHaveLength(1)
    })

    it("writes a newer cart's order when another sync created it at the same moment", async () => {
        const { cartId, paymentId, refund, order } = await paid()
        expect((await refund()).status).toBe(200)
        await OrderModel.deleteMany({})
        const cart = (await CartModel.findById(cartId))!
        // The other sync's insert wins the race, with the payment as it was
        // before the refund; this one's insert then meets the unique index.
        const race = jest.spyOn(OrderModel, "updateOne").mockImplementationOnce((async () => {
            await OrderModel.collection.insertOne({
                paymentId: new mongoose.Types.ObjectId(paymentId), cartVersion: cart.__v, refunds: [], lines: [],
            })
            throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 })
        }) as unknown as typeof OrderModel.updateOne)
        try {
            expect(await syncOrder(cart, paymentId)).toBe("updated")
        } finally {
            race.mockRestore()
        }
        expect((await order())?.refunds).toHaveLength(1)
        expect((await order())?.lines).toHaveLength(1)
    })

    it("fills in a table name a first write couldn't find", async () => {
        const { paymentId, order, resync } = await paid()
        await OrderModel.updateOne({ paymentId }, { $unset: { tableName: 1 } })

        await resync()
        expect((await order())?.tableName).toBe("T1")
    })

    it("keeps the category it gave a line paid before categories were kept, whatever the menu does after", async () => {
        const { cartId, paymentId, latte, resync } = await paid()
        await forgetCategory(cartId)
        await resync()

        await MenuModel.updateOne({ _id: latte }, { category: "food" })
        await resync()
        await MenuModel.deleteOne({ _id: latte })
        await resync()
        expect((await OrderModel.findOne({ paymentId }))?.lines[0].category).toBe("drinks")
    })

    it("refuses a cart with no creation date rather than writing an order without one", async () => {
        const { cartId, resync } = await paid()
        await CartModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(cartId) }, { $unset: { createdAt: 1 } })

        await expect(resync()).rejects.toThrow("no creation date")
    })

    it("refuses an order that breaks the schema rather than writing it", async () => {
        const { cartId, resync } = await paid()
        await CartModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(cartId) }, { $set: { "payments.0.status": "lost" } })

        await expect(resync()).rejects.toThrow()
    })

    it("finds the shop of a cart saved without one, by its table", async () => {
        const { shopId, cartId, paymentId, resync } = await paid()
        await OrderModel.deleteMany({})
        await CartModel.updateOne({ _id: cartId }, { $unset: { shopId: 1 } })

        await resync()
        expect(String((await OrderModel.findOne({ paymentId }))?.shopId)).toBe(shopId)
    })

    it("gives a line paid before categories were kept its item's current one, or none", async () => {
        const { cartId, paymentId, latte, resync } = await paid()
        await forgetCategory(cartId)
        await resync()
        expect((await OrderModel.findOne({ paymentId }))?.lines[0].category).toBe("drinks")

        await MenuModel.deleteOne({ _id: latte })
        await OrderModel.deleteMany({})
        await resync()
        expect((await OrderModel.findOne({ paymentId }))?.lines[0].category).toBeNull()
    })
})

describe("refund reasons", () => {
    const REASONS = REFUND_REASONS.filter((r) => r !== "other")

    it("takes each listed reason, and Other with a note", async () => {
        for (const reason of REASONS) {
            const { refund, cartId } = await paid()
            expect([reason, (await refund({ reason })).status]).toEqual([reason, 200])
            expect((await CartModel.findById(cartId))!.refunds[0]).toMatchObject({ reason })
        }
    })

    it("still takes a refund without a reason, from a frontend that doesn't send one", async () => {
        const { refund, cartId, order } = await paid()
        expect((await refund({ reason: undefined })).status).toBe(200)
        expect((await CartModel.findById(cartId))!.refunds[0].reason).toBeUndefined()
        expect((await order())?.refunds[0].reason).toBeUndefined()
    })

    it("refuses an unknown reason, Other without a note, a note without Other, and a note over 200 characters", async () => {
        const { refund } = await paid()
        for (const body of [
            { reason: "because" },
            { reason: "other" },
            { reason: "other", reasonNote: "   " },
            { reason: "quality", reasonNote: "Cold" },
            { reason: "other", reasonNote: "x".repeat(201) },
        ]) {
            const res = await refund(body)
            expect([JSON.stringify(body), res.status, res.body.message]).toEqual([JSON.stringify(body), 400, "Validation failed"])
        }
    })
})

describe("orders as sales history", () => {
    it("outlive their shop and their payer's account", async () => {
        const { owner, shopId, cartId, ada, paymentId } = await paid()
        await closedLongAgo(cartId)

        expect((await request(app).delete("/users/me").set("Cookie", ada.cookies).send({ currentPassword: ada.password })).status).toBe(204)
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)
        expect(await CartModel.countDocuments()).toBe(0)
        expect(await ShopModel.countDocuments({ _id: shopId })).toBe(0)
        expect(await OrderModel.findOne({ paymentId })).toMatchObject({ shopId: new mongoose.Types.ObjectId(shopId), payerId: ada.user._id })
    })

    it("are written before their shop's carts are deleted, and the shop stays if they can't be", async () => {
        // An order whose sync failed at checkout.
        const lost = await paid()
        await closedLongAgo(lost.cartId)
        await OrderModel.deleteMany({})

        const write = jest.spyOn(OrderModel, "updateOne").mockRejectedValueOnce(new Error("database blip"))
        const quiet = jest.spyOn(console, "error").mockImplementation(() => {})
        const refused = await request(app).delete(`/shops/${lost.shopId}`).set("Cookie", lost.owner.cookies)
        write.mockRestore()
        quiet.mockRestore()
        expect(refused.status).toBe(500)
        expect(await CartModel.countDocuments({ _id: lost.cartId })).toBe(1)

        expect((await request(app).delete(`/shops/${lost.shopId}`).set("Cookie", lost.owner.cookies)).status).toBe(204)
        expect(await CartModel.countDocuments({ _id: lost.cartId })).toBe(0)
        expect(await lost.order()).toMatchObject({ status: "completed", tableName: "T1" })
    })

    it("rewrites none before deleting a shop when they all match their payments, however the carts changed since", async () => {
        const { owner, shopId, cartId } = await paid()
        // Saved again (a later note, then closed): its version moves, its money doesn't.
        const cart = (await CartModel.findById(cartId))!
        cart.notices.push({ at: new Date(), message: "Thanks" })
        await cart.save()
        await closedLongAgo(cartId)

        const writes = jest.spyOn(OrderModel, "updateOne")
        try {
            expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)
            expect(writes).not.toHaveBeenCalled()
        } finally {
            writes.mockRestore()
        }
    })

    it("are rebuilt by the repair script from the carts, and a second run changes nothing", async () => {
        await paid()
        await paid()
        await OrderModel.deleteMany({})

        expect(await syncAllOrders()).toEqual({ created: 2, updated: 0, unchanged: 0, failed: 0 })
        expect(await syncAllOrders()).toEqual({ created: 0, updated: 0, unchanged: 2, failed: 0 })
    })

    it("goes on past a payment it can't write, and counts it", async () => {
        await paid()
        const { cartId } = await paid()
        await OrderModel.deleteMany({})
        // A cart with no shop recorded, at a table no shop has.
        await CartModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(cartId) }, { $unset: { shopId: 1 }, $set: { tableId: String(new mongoose.Types.ObjectId()) } })
        const quiet = jest.spyOn(console, "error").mockImplementation(() => {})

        expect(await syncAllOrders()).toEqual({ created: 1, updated: 0, unchanged: 0, failed: 1 })
        expect(quiet).toHaveBeenCalled()
        quiet.mockRestore()
    })

    it("are indexed for the report: a shop's orders in a period read no collection whole", async () => {
        await OrderModel.init()
        const names = (await OrderModel.collection.indexes()).map((i) => i.name)
        expect(names).toEqual(expect.arrayContaining(["paymentId_1", "shopId_1_paidAt_1", "shopId_1_refunds.at_1", "shopId_1_payerId_1_paidAt_1"]))

        const shopId = new mongoose.Types.ObjectId()
        const plan = (await OrderModel.find({ shopId, paidAt: { $gte: new Date(0), $lt: new Date() } }).explain()) as unknown as { queryPlanner: { winningPlan: unknown } }
        expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('"indexName":"shopId_1_paidAt_1"')
    })
})
