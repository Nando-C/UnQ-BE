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
import "./setup"
import app from "../server"
import { authFor } from "./helpers"
import CartModel from "../services/carts/model"
import { getOrder, captureOrder, refundCapture, PayPalOrder } from "../lib/paypal"

const mockedGetOrder = jest.mocked(getOrder)
const mockedCapture = jest.mocked(captureOrder)
const mockedRefund = jest.mocked(refundCapture)

beforeEach(() => {
    mockedGetOrder.mockReset()
    mockedCapture.mockReset()
    mockedRefund.mockReset()
})

// The order as PayPal shows it, its capture in `captureStatus`.
const orderWith = (captureStatus: string, value = "6.00"): PayPalOrder => ({
    id: "ORDER-1",
    status: "COMPLETED",
    purchase_units: [{
        amount: { currency_code: "GBP", value },
        payments: { captures: [{ id: "CAP-1", status: captureStatus, amount: { currency_code: "GBP", value } }] },
    }],
})

// Ada orders 2 £3 Lattes and pays for both; PayPal holds the capture as
// PENDING. `extra` more Lattes are ordered but not paid.
const paidPending = async ({ extra = 0 } = {}) => {
    const owner = await authFor("shopMg")
    const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
    const tableId = (await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name: "T1" })).body._id
    const latte = (await request(app).post(`/shops/${shopId}/menu`).set("Cookie", owner.cookies)
        .send({ name: "Latte", short_description: "x", price: 3, category: "drinks" })).body._id as string
    const ada = await authFor("customer")
    const cartId = (await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", ada.cookies)
        .send({ menuId: latte, qty: 2 + extra })).body._id as string
    await request(app).post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`).set("Cookie", ada.cookies)
        .send({ menuId: latte, qty: 2 })

    mockedGetOrder.mockResolvedValueOnce({
        id: "ORDER-1", status: "APPROVED",
        purchase_units: [{ amount: { currency_code: "GBP", value: "6.00" }, custom_id: `${cartId}:${ada.user._id}` }],
    })
    mockedCapture.mockResolvedValueOnce(orderWith("PENDING"))
    const checkout = await request(app).post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
        .set("Cookie", ada.cookies).send({ paypalOrderId: "ORDER-1" })

    const paymentId = String((await CartModel.findById(cartId))!.payments[0]._id)
    const check = (who = owner) =>
        request(app).post(`/shops/${shopId}/carts/${cartId}/payments/${paymentId}/check`).set("Cookie", who.cookies)
    return { owner, shopId, tableId, latte, ada, cartId, paymentId, checkout, check }
}

describe("a payment PayPal holds as pending at checkout", () => {
    it("holds the diner's units as paid, answers 202, and keeps the table open", async () => {
        const { checkout, cartId } = await paidPending()

        expect(checkout.status).toBe(202)
        const cart = await CartModel.findById(cartId)
        expect(cart!.payments[0]).toMatchObject({ status: "pending", providerPaymentId: "CAP-1", amount: 6 })
        expect(cart!.items[0].qtyPayed).toBe(2)
        expect(cart!.split[0].splitStatus).toBe("closed")
        // Everything is paid, but the cart waits for PayPal before closing.
        expect(cart!.status).toBe("open")
    })

    it("flags the table for the manager", async () => {
        const { owner, shopId } = await paidPending()
        const res = await request(app).get(`/shops/${shopId}/tables/status`).set("Cookie", owner.cookies)
        expect(res.body[0].attention).toContain("paymentPending")
    })

    it("can't be refunded, nor its table closed, until it's checked", async () => {
        const { owner, shopId, tableId, cartId, paymentId, latte } = await paidPending()

        const refund = await request(app).post(`/shops/${shopId}/carts/${cartId}/refunds`).set("Cookie", owner.cookies)
            .send({ paymentId, lines: [{ menuId: latte, qty: 1 }] })
        expect(refund.status).toBe(409)
        expect(refund.body.message).toBe("PayPal hasn't confirmed this payment yet: check it first")
        expect(mockedRefund).not.toHaveBeenCalled()

        const close = await request(app).post(`/shops/${shopId}/tables/${tableId}/carts/${cartId}/close`).set("Cookie", owner.cookies)
        expect(close.status).toBe(409)
        expect(close.body.message).toBe("A payment on this table is still awaiting PayPal: check it first")
    })

    it("keeps the table open when the diner takes off the last unpaid unit", async () => {
        const { ada, shopId, tableId, latte, cartId } = await paidPending({ extra: 1 })

        const res = await request(app).post(`/carts/${shopId}/tables/${tableId}/removeItem`).set("Cookie", ada.cookies)
            .send({ menuId: latte, qty: 1 })

        expect(res.status).toBe(200)
        const cart = await CartModel.findById(cartId)
        expect(cart!.items[0]).toMatchObject({ qty: 2, qtyPayed: 2 })
        expect(cart!.status).toBe("open")
    })

    it("keeps the table open when a manager removes the last unpaid units", async () => {
        const { owner, shopId, tableId, latte, cartId } = await paidPending({ extra: 1 })

        const res = await request(app).post(`/shops/${shopId}/tables/${tableId}/carts/${cartId}/removeItem`)
            .set("Cookie", owner.cookies).send({ menuId: latte })

        expect(res.status).toBe(200)
        const cart = await CartModel.findById(cartId)
        expect(cart!.items[0]).toMatchObject({ qty: 2, qtyPayed: 2 })
        expect(cart!.status).toBe("open")
    })
})

describe("POST /shops/:shopId/carts/:cartId/payments/:paymentId/check", () => {
    it("confirms a payment PayPal completed, closing the paid-off cart", async () => {
        const { check, cartId, ada } = await paidPending()
        mockedGetOrder.mockResolvedValueOnce(orderWith("COMPLETED"))

        const res = await check()

        expect(res.status).toBe(200)
        expect(res.body.payment.status).toBe("completed")
        expect(mockedGetOrder).toHaveBeenLastCalledWith("ORDER-1")
        const cart = await CartModel.findById(cartId)
        expect(cart!.status).toBe("closed")
        expect(cart!.notices.at(-1)).toMatchObject({ message: "PayPal confirmed your payment of £6.00.", forUserId: ada.user._id })
    })

    it("makes the units unpaid again, back in the payer's selection, when PayPal declined it", async () => {
        const { check, cartId, owner, shopId } = await paidPending({ extra: 1 })
        mockedGetOrder.mockResolvedValueOnce(orderWith("DECLINED"))

        const res = await check()

        expect(res.status).toBe(200)
        expect(res.body.payment.status).toBe("failed")
        const cart = await CartModel.findById(cartId)
        expect(cart!.items[0]).toMatchObject({ qty: 3, qtyPayed: 0 })
        expect(cart!.split).toHaveLength(1)
        expect(cart!.split[0]).toMatchObject({ qty: 2, splitStatus: "open" })
        expect(cart!.split[0].paidAt).toBeUndefined()
        expect(cart!.status).toBe("open")
        expect(cart!.notices.at(-1)!.message).toBe(
            "PayPal didn't complete your payment of £6.00, so nothing was taken. Those items are unpaid again.")
        // The table no longer counts it as paid.
        const status = await request(app).get(`/shops/${shopId}/tables/status`).set("Cookie", owner.cookies)
        expect(status.body[0]).toMatchObject({ paid: 0, owed: 9 })
        expect(status.body[0].attention).not.toContain("paymentPending")
    })

    it("folds the reopened units into a selection the payer made since", async () => {
        const { check, cartId, ada, shopId, tableId, latte } = await paidPending({ extra: 1 })
        await request(app).post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`).set("Cookie", ada.cookies)
            .send({ menuId: latte, qty: 1 })
        mockedGetOrder.mockResolvedValueOnce(orderWith("DECLINED"))

        expect((await check()).status).toBe(200)

        const cart = await CartModel.findById(cartId)
        expect(cart!.split).toHaveLength(1)
        expect(cart!.split[0]).toMatchObject({ qty: 3, splitStatus: "open" })
    })

    it("reopens a cart that had closed when PayPal declined it, so the units can be paid", async () => {
        const { check, cartId } = await paidPending()
        await CartModel.updateOne({ _id: cartId }, { $set: { status: "closed" } })
        mockedGetOrder.mockResolvedValueOnce(orderWith("DECLINED"))

        expect((await check()).status).toBe(200)

        const cart = await CartModel.findById(cartId)
        expect(cart!.status).toBe("open")
        expect(cart!.items[0].qtyPayed).toBe(0)
    })

    it("changes nothing while PayPal is still processing it", async () => {
        const { check, cartId } = await paidPending()
        mockedGetOrder.mockResolvedValueOnce(orderWith("PENDING"))

        const res = await check()

        expect(res.status).toBe(409)
        expect(res.body.message).toBe("PayPal is still processing this payment. Check again later")
        expect((await CartModel.findById(cartId))!.payments[0].status).toBe("pending")
    })

    it("changes nothing when PayPal can't be reached", async () => {
        const { check, cartId } = await paidPending()
        mockedGetOrder.mockRejectedValueOnce(new Error("PayPal order lookup failed (503)"))

        const res = await check()

        expect(res.status).toBe(502)
        expect(res.body.message).toBe("Couldn't check with PayPal (PayPal order lookup failed (503)). Try again shortly.")
        expect((await CartModel.findById(cartId))!.payments[0].status).toBe("pending")
    })

    it("does nothing for a payment that isn't pending", async () => {
        const { check } = await paidPending()
        mockedGetOrder.mockResolvedValueOnce(orderWith("COMPLETED"))
        await check()
        mockedGetOrder.mockClear()

        const again = await check()
        expect(again.status).toBe(409)
        expect(again.body.message).toBe("This payment isn't awaiting confirmation any more")
        expect(mockedGetOrder).not.toHaveBeenCalled()
    })

    it("is for that shop's managers only", async () => {
        const { check, ada } = await paidPending()
        expect((await check(ada)).status).toBe(403)
        expect((await check(await authFor("shopMg"))).status).toBe(403)
        expect(mockedGetOrder).toHaveBeenCalledTimes(1) // the checkout's own
    })
})
