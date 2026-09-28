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
import { refundCapture, findRefund, PayPalRefundRefused } from "../lib/paypal"

const mockedRefund = jest.mocked(refundCapture)
const mockedFind = jest.mocked(findRefund)

beforeEach(() => {
    mockedRefund.mockReset()
    mockedRefund.mockResolvedValue("REF-1")
    mockedFind.mockReset()
    mockedFind.mockResolvedValue(null)
})

// A shop with a £3 Latte and a £2 Muffin; Ada ordered 3 Lattes and a Muffin and
// has paid for 2 Lattes and the Muffin (£8, capture CAP-1).
// `captureId: null` records the payment without one.
const scaffold = async ({ captureId = "CAP-1" as string | null } = {}) => {
    const owner = await authFor("shopMg")
    const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
    const tableId = (await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name: "T1" })).body._id
    const item = async (name: string, price: number) =>
        (await request(app).post(`/shops/${shopId}/menu`).set("Cookie", owner.cookies)
            .send({ name, short_description: "x", price, category: "drinks" })).body._id as string
    const latte = await item("Latte", 3)
    const muffin = await item("Muffin", 2)
    const ada = await authFor("customer")
    const add = (menuId: string, qty: number) =>
        request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", ada.cookies).send({ menuId, qty })
    const cartId = (await add(latte, 3)).body._id as string
    await add(muffin, 1)

    const paidAt = new Date()
    await CartModel.updateOne({ _id: cartId }, {
        $set: { "items.0.qtyPayed": 2, "items.1.qtyPayed": 1 },
        $push: {
            split: {
                $each: [
                    { userId: ada.user._id, menuId: latte, qty: 2, splitStatus: "closed", unitPrice: 3, paidAt },
                    { userId: ada.user._id, menuId: muffin, qty: 1, splitStatus: "closed", unitPrice: 2, paidAt },
                ],
            },
            payments: {
                provider: "paypal", providerCheckoutId: "ORDER-1", ...(captureId ? { providerPaymentId: captureId } : {}), currency: "GBP",
                userId: ada.user._id, paidAt, amount: 8,
                lines: [
                    { menuId: latte, name: "Latte", qty: 2, unitPrice: 3 },
                    { menuId: muffin, name: "Muffin", qty: 1, unitPrice: 2 },
                ],
            },
        },
    })
    const paymentId = String((await CartModel.findById(cartId))!.payments[0]._id)
    const refund = (lines: { menuId: string; qty: number }[], who = owner, shop = shopId) =>
        request(app).post(`/shops/${shop}/carts/${cartId}/refunds`).set("Cookie", who.cookies).send({ paymentId, lines })

    return { owner, shopId, tableId, latte, muffin, ada, cartId, paymentId, refund }
}

describe("POST /shops/:shopId/carts/:cartId/refunds", () => {
    it("refunds units at the price paid, takes them out of the cart and tells the payer", async () => {
        const { tableId, latte, ada, cartId, refund } = await scaffold()

        const res = await refund([{ menuId: latte, qty: 1 }])

        expect(res.status).toBe(200)
        expect(res.body.refund).toMatchObject({ status: "completed", amount: 3, currency: "GBP", providerRefundId: "REF-1" })
        // PayPal was asked for exactly £3.00 of CAP-1, keyed by the refund's own id.
        expect(mockedRefund).toHaveBeenCalledTimes(1)
        expect(mockedRefund).toHaveBeenCalledWith("CAP-1", { value: "3.00", currency: "GBP", requestId: res.body.refund._id })

        const cart = await CartModel.findById(cartId)
        const line = cart!.items.find((i) => String(i.menuId) === latte)
        expect([line?.qty, line?.qtyPayed]).toEqual([2, 1]) // one paid, one still to pay
        const split = cart!.split.find((s) => String(s.menuId) === latte)
        expect(split?.qty).toBe(1)
        expect(cart!.payments[0].lines[0].refundedQty).toBe(1)
        expect(cart!.managerLog.at(-1)).toMatchObject({ action: "refund", details: expect.stringContaining("£3.00 for 1× Latte") })

        // Ada's note, on her own view of the table's cart; none of the records.
        const forAda = await request(app).get(`/carts/tables/${tableId}`).set("Cookie", ada.cookies)
        expect(forAda.body.notices.map((n: { message: string }) => n.message)).toEqual(["The staff refunded £3.00 for 1× Latte."])
        expect(forAda.body).not.toHaveProperty("refunds")
        expect(forAda.body).not.toHaveProperty("payments")
    })

    it("refunds several items at once, and works on a closed cart", async () => {
        const { latte, muffin, cartId, refund } = await scaffold()
        await CartModel.updateOne({ _id: cartId }, { status: "closed" })

        const res = await refund([{ menuId: latte, qty: 2 }, { menuId: muffin, qty: 1 }])

        expect(res.status).toBe(200)
        expect(res.body.refund.amount).toBe(8)
        expect(mockedRefund).toHaveBeenCalledWith("CAP-1", expect.objectContaining({ value: "8.00" }))
        const cart = await CartModel.findById(cartId)
        expect(cart!.items.map((i) => [String(i.menuId), i.qty, i.qtyPayed])).toEqual([[latte, 1, 0]]) // Muffin gone
        expect(cart!.split).toEqual([])
    })

    it("never refunds more than was paid and not yet refunded", async () => {
        const { latte, muffin, refund } = await scaffold()

        const tooMany = await refund([{ menuId: latte, qty: 3 }])
        expect(tooMany.status).toBe(400)
        expect(tooMany.body.message).toBe("Only 2× Latte of this payment can still be refunded")

        await refund([{ menuId: muffin, qty: 1 }])
        const again = await refund([{ menuId: muffin, qty: 1 }])
        expect(again.status).toBe(400)
        expect(again.body.message).toBe("Muffin from this payment has already been refunded")
        expect(mockedRefund).toHaveBeenCalledTimes(1)
    })

    it("refuses items that aren't in the payment, and the same item twice", async () => {
        const { latte, refund } = await scaffold()
        const other = "aaaaaaaaaaaaaaaaaaaaaaaa"
        expect((await refund([{ menuId: other, qty: 1 }])).status).toBe(400)
        expect((await refund([{ menuId: latte, qty: 1 }, { menuId: latte, qty: 1 }])).status).toBe(400)
        expect(mockedRefund).not.toHaveBeenCalled()
    })

    it("refunds the last unit once when two refunds race for it", async () => {
        const { latte, refund } = await scaffold()
        await refund([{ menuId: latte, qty: 1 }]) // one Latte left to refund
        mockedRefund.mockClear()

        const results = await Promise.all([refund([{ menuId: latte, qty: 1 }]), refund([{ menuId: latte, qty: 1 }])])

        expect(results.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1)
        expect(results.map((r) => r.status).filter((s) => s !== 200)[0]).toBeGreaterThanOrEqual(400)
        expect(mockedRefund).toHaveBeenCalledTimes(1)
    })

    it("changes nothing when PayPal refuses, and says why", async () => {
        const { latte, cartId, refund } = await scaffold()
        mockedRefund.mockRejectedValueOnce(new PayPalRefundRefused("PayPal refund failed (422): Refund amount exceeded"))

        const res = await refund([{ menuId: latte, qty: 1 }])

        expect(res.status).toBe(502)
        expect(res.body.message).toBe("PayPal refund failed (422): Refund amount exceeded. Nothing was refunded.")
        const cart = await CartModel.findById(cartId)
        expect(cart!.items[0]).toMatchObject({ qty: 3, qtyPayed: 2 })
        expect(cart!.payments[0].lines[0].refundedQty).toBe(0)
        expect(cart!.refunds[0]).toMatchObject({ status: "failed", failureReason: "PayPal refund failed (422): Refund amount exceeded" })
        // A failed refund doesn't hold the units: they can be refunded again.
        expect((await refund([{ menuId: latte, qty: 2 }])).status).toBe(200)
    })

    it("keeps the refund in progress when PayPal gives no clear answer, so it can't be sent twice", async () => {
        const { latte, cartId, refund } = await scaffold()
        // A timeout or a 5xx: PayPal may have refunded.
        mockedRefund.mockRejectedValueOnce(new Error("PayPal refund failed (503)"))
        const quiet = jest.spyOn(console, "error").mockImplementation(() => {})

        const res = await refund([{ menuId: latte, qty: 2 }])
        quiet.mockRestore()

        expect(res.status).toBe(502)
        expect(res.body.message).toBe(
            "PayPal didn't confirm the refund (PayPal refund failed (503)). It shows as in progress: retry it, which checks with PayPal first.")
        const cart = await CartModel.findById(cartId)
        expect(cart!.refunds[0].status).toBe("pending")
        expect(cart!.items[0]).toMatchObject({ qty: 3, qtyPayed: 2 }) // nothing taken off the cart yet
        // The units stay held: a second refund under a new request id is refused.
        expect((await refund([{ menuId: latte, qty: 1 }])).status).toBe(400)
        expect(mockedRefund).toHaveBeenCalledTimes(1)
    })

    it("leaves the refund in progress, and says so, if it went through but can't be recorded", async () => {
        const { latte, cartId, refund } = await scaffold()
        const save = CartModel.prototype.save
        let saves = 0
        // The pending record saves; every later save meets a newer version.
        const spy = jest.spyOn(CartModel.prototype, "save").mockImplementation(async function (this: typeof CartModel.prototype) {
            if (saves++ > 0) await CartModel.updateOne({ _id: this._id }, { $inc: { __v: 1 } })
            return save.call(this)
        } as never)
        const quiet = jest.spyOn(console, "error").mockImplementation(() => {})

        const res = await refund([{ menuId: latte, qty: 1 }])
        spy.mockRestore()
        quiet.mockRestore()

        expect(res.status).toBe(500)
        expect(res.body.message).toBe("The refund went through at PayPal but couldn't be recorded here. It shows as in progress: retry it to record it.")
        expect(mockedRefund).toHaveBeenCalledTimes(1)
        const cart = await CartModel.findById(cartId)
        expect(cart!.refunds[0].status).toBe("pending")
        // And it still holds the unit, so it can't be refunded twice meanwhile.
        expect((await refund([{ menuId: latte, qty: 2 }])).status).toBe(400)
    })

    it("sends payments without a recorded capture to PayPal's dashboard", async () => {
        const { latte, refund } = await scaffold({ captureId: null })
        const res = await refund([{ menuId: latte, qty: 1 }])
        expect(res.status).toBe(409)
        expect(res.body.message).toBe("This payment can only be refunded from PayPal")
        expect(mockedRefund).not.toHaveBeenCalled()
    })

    it("is for that shop's managers only", async () => {
        const { latte, ada, refund } = await scaffold()
        const otherManager = await authFor("shopMg")
        expect((await refund([{ menuId: latte, qty: 1 }], ada)).status).toBe(403)
        expect((await refund([{ menuId: latte, qty: 1 }], otherManager)).status).toBe(403)
        // Their own shop's URL doesn't reach this cart either.
        const theirShop = (await request(app).post("/shops").set("Cookie", otherManager.cookies).send({ name: "Other" })).body._id
        expect((await refund([{ menuId: latte, qty: 1 }], otherManager, theirShop)).status).toBe(404)
        expect(mockedRefund).not.toHaveBeenCalled()
    })
})

describe("POST /shops/:shopId/carts/:cartId/refunds/:refundId/retry", () => {
    // A £6 refund of both Lattes left in progress: PayPal timed out.
    const leftPending = async () => {
        const ctx = await scaffold()
        mockedRefund.mockRejectedValueOnce(new Error("PayPal refund failed (503)"))
        const quiet = jest.spyOn(console, "error").mockImplementation(() => {})
        await ctx.refund([{ menuId: ctx.latte, qty: 2 }])
        quiet.mockRestore()
        mockedRefund.mockClear()
        const refundId = String((await CartModel.findById(ctx.cartId))!.refunds[0]._id)
        const retry = (who = ctx.owner) =>
            request(app).post(`/shops/${ctx.shopId}/carts/${ctx.cartId}/refunds/${refundId}/retry`).set("Cookie", who.cookies)
        return { ...ctx, refundId, retry }
    }

    it("records a refund PayPal already made, without sending it again", async () => {
        const { cartId, latte, refundId, retry } = await leftPending()
        mockedFind.mockResolvedValue({ id: "REF-9", status: "COMPLETED" })

        const res = await retry()

        expect(res.status).toBe(200)
        expect(res.body.refund).toMatchObject({ status: "completed", providerRefundId: "REF-9", amount: 6 })
        expect(mockedFind).toHaveBeenCalledWith("ORDER-1", refundId)
        expect(mockedRefund).not.toHaveBeenCalled()
        const cart = await CartModel.findById(cartId)
        expect(cart!.items.find((i) => String(i.menuId) === latte)).toMatchObject({ qty: 1, qtyPayed: 0 })
        expect(cart!.payments[0].lines[0].refundedQty).toBe(2)
    })

    it("sends it again under the same id when PayPal doesn't have it", async () => {
        const { refundId, retry } = await leftPending()

        const res = await retry()

        expect(res.status).toBe(200)
        expect(res.body.refund.status).toBe("completed")
        expect(mockedRefund).toHaveBeenCalledWith("CAP-1", { value: "6.00", currency: "GBP", requestId: refundId })
    })

    it("marks it failed when PayPal says it failed, freeing the units", async () => {
        const { latte, cartId, retry, refund } = await leftPending()
        mockedFind.mockResolvedValue({ id: "REF-9", status: "FAILED" })

        const res = await retry()

        expect(res.status).toBe(502)
        expect(res.body.message).toBe("PayPal says this refund failed. Nothing was refunded.")
        expect((await CartModel.findById(cartId))!.refunds[0].status).toBe("failed")
        expect((await refund([{ menuId: latte, qty: 2 }])).status).toBe(200)
    })

    it("stays in progress when PayPal can't be reached", async () => {
        const { cartId, retry } = await leftPending()
        mockedFind.mockRejectedValue(new Error("PayPal order lookup failed (503)"))

        const res = await retry()

        expect(res.status).toBe(502)
        expect(res.body.message).toBe(
            "Couldn't check with PayPal (PayPal order lookup failed (503)). The refund is still in progress: try again shortly.")
        expect((await CartModel.findById(cartId))!.refunds[0].status).toBe("pending")
        expect(mockedRefund).not.toHaveBeenCalled()
    })

    it("does nothing for a refund that isn't in progress", async () => {
        const { retry } = await leftPending()
        mockedFind.mockResolvedValue({ id: "REF-9", status: "COMPLETED" })
        await retry()
        mockedFind.mockClear()

        const again = await retry()
        expect(again.status).toBe(409)
        expect(again.body.message).toBe("This refund isn't in progress any more")
        expect(mockedFind).not.toHaveBeenCalled()
    })

    it("is for that shop's managers only", async () => {
        const { ada, retry } = await leftPending()
        expect((await retry(ada)).status).toBe(403)
        expect((await retry(await authFor("shopMg"))).status).toBe(403)
        expect(mockedFind).not.toHaveBeenCalled()
    })
})

