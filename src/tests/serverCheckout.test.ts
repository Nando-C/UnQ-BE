import { jest, describe, it, expect, beforeEach } from "@jest/globals"

// Mock the PayPal client at the module boundary before the app is imported, so
// no network call is ever made and each test controls the whole PayPal surface.
jest.mock("../lib/paypal", () => ({
    getOrder: jest.fn(),
    createOrder: jest.fn(),
    captureOrder: jest.fn(),
    refundCapture: jest.fn(),
    PayPalRefundRefused: jest.requireActual<typeof import("../lib/paypal")>("../lib/paypal").PayPalRefundRefused,
    PayPalCaptureRefused: jest.requireActual<typeof import("../lib/paypal")>("../lib/paypal").PayPalCaptureRefused,
}))

import request from "supertest"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"
import CartModel from "../services/carts/model"
import { getOrder, createOrder, captureOrder, refundCapture, PayPalOrder, PayPalCaptureRefused } from "../lib/paypal"

const mockedGetOrder = jest.mocked(getOrder)
const mockedCreateOrder = jest.mocked(createOrder)
const mockedCaptureOrder = jest.mocked(captureOrder)
const mockedRefundCapture = jest.mocked(refundCapture)

// A buyer-APPROVED order (created server-side, not yet captured) bound to a payer.
const approvedOrder = (
    value: string,
    customId: string,
    { id = "ORDER-1", currency = "GBP", status = "APPROVED" } = {}
): PayPalOrder => ({
    id,
    status,
    purchase_units: [{ amount: { currency_code: currency, value }, custom_id: customId }],
})

// A COMPLETED capture result body (what captureOrder returns after charging).
const capturedOrder = (
    value: string,
    { id = "ORDER-1", captureId = "CAPTURE-1", currency = "GBP" } = {}
): PayPalOrder => ({
    id,
    status: "COMPLETED",
    purchase_units: [
        {
            amount: { currency_code: currency, value },
            payments: {
                captures: [{ id: captureId, status: "COMPLETED", amount: { currency_code: currency, value } }],
            },
        },
    ],
})

// Build a shop + table + £3 menu item and add it to a customer's cart. A split
// entry is added per-test so amounts can vary.
const scaffold = async ({ qty = 2 } = {}) => {
    const owner = await authFor("shopMg")

    const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
    const tableId = (
        await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name: "T1" })
    ).body._id
    const menuId = (
        await request(app)
            .post(`/shops/${shopId}/menu`)
            .set("Cookie", owner.cookies)
            .send({ name: "Latte", short_description: "Milky", price: 3, category: "drinks" })
    ).body._id

    const customer = await authFor("customer")
    const cartId = (
        await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty })
    ).body._id

    const addSplit = (cookies: string[], q: number, m: string = menuId) =>
        request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", cookies)
            .send({ menuId: m, qty: q })

    const addNamedItem = async (name: string, q: number) => {
        const id = (
            await request(app)
                .post(`/shops/${shopId}/menu`)
                .set("Cookie", owner.cookies)
                .send({ name, short_description: "x", price: 3, category: "drinks" })
        ).body._id
        await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId: id, qty: q })
        return id
    }

    return { owner, shopId, tableId, menuId, customer, cartId, addSplit, addNamedItem }
}

beforeEach(() => {
    mockedGetOrder.mockReset()
    mockedCreateOrder.mockReset()
    mockedCaptureOrder.mockReset()
    mockedRefundCapture.mockReset()
})

// --------------------------------------------------------------------------

describe("createCheckoutOrder (POST /carts/tables/:tableId/:cartId/createCheckoutOrder)", () => {
    it("creates an order for the DB-priced total bound to the cart + payer", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold() // item qty 2
        await addSplit(customer.cookies, 2) // £6.00 due
        mockedCreateOrder.mockResolvedValue("PAYPAL-NEW")

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/createCheckoutOrder`)
            .set("Cookie", customer.cookies)

        expect(res.status).toBe(200)
        expect(res.body).toEqual({ paypalOrderId: "PAYPAL-NEW" })
        expect(mockedCreateOrder).toHaveBeenCalledWith("6.00", `${cartId}:${customer.user._id}`)

        // Nothing is charged or persisted at this stage.
        const cart = await CartModel.findById(cartId)
        expect(cart?.paypalOrderIds).toBeUndefined()
        expect(cart?.split[0].splitStatus).toBe("open")
    })

    it("rejects with 409 and never calls PayPal when availability is exceeded", async () => {
        const { tableId, cartId, customer, menuId } = await scaffold({ qty: 1 }) // one unit
        // Inject a caller split for 2 units on a 1-unit item (bypasses addSplit's guard).
        await CartModel.findByIdAndUpdate(cartId, {
            $push: { split: { userId: customer.user._id, menuId, qty: 2, splitStatus: "open" } },
        })

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/createCheckoutOrder`)
            .set("Cookie", customer.cookies)

        expect(res.status).toBe(409)
        expect(mockedCreateOrder).not.toHaveBeenCalled()
    })

    it("rejects with 409 and never calls PayPal when a selected item is sold out", async () => {
        const { owner, shopId, tableId, menuId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 1)
        await request(app).put(`/shops/${shopId}/menu/${menuId}`).set("Cookie", owner.cookies).send({ available: false })

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/createCheckoutOrder`)
            .set("Cookie", customer.cookies)

        expect(res.status).toBe(409)
        expect(res.body.message).toMatch(/^Some items you selected are sold out/)
        expect(mockedCreateOrder).not.toHaveBeenCalled()
    })

    it("still checks out the rest of the cart after a menu item in it is deleted", async () => {
        const { owner, shopId, tableId, menuId, cartId, customer, addSplit, addNamedItem } = await scaffold()
        const muffinId = await addNamedItem("Muffin", 1)
        await addSplit(customer.cookies, 1, muffinId) // £3.00 due, on the item that stays
        // The first line's menu item is deleted: its cart line comes before mine.
        await request(app).delete(`/shops/${shopId}/menu/${menuId}`).set("Cookie", owner.cookies)
        mockedCreateOrder.mockResolvedValue("PAYPAL-NEW")

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/createCheckoutOrder`)
            .set("Cookie", customer.cookies)

        expect(res.status).toBe(200)
        expect(mockedCreateOrder).toHaveBeenCalledWith("3.00", `${cartId}:${customer.user._id}`)
    })

    it("shows a deleted menu item as sold out with its id, so it can be removed", async () => {
        const { owner, shopId, tableId, menuId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 1)
        await request(app).delete(`/shops/${shopId}/menu/${menuId}`).set("Cookie", owner.cookies)

        const cartRes = await request(app).get(`/carts/tables/${tableId}`)
        expect(cartRes.body.items[0].menuId).toMatchObject({ _id: String(menuId), available: false })
        expect(cartRes.body.split[0].menuId).toMatchObject({ _id: String(menuId), available: false })

        const checkout = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/createCheckoutOrder`)
            .set("Cookie", customer.cookies)
        expect(checkout.status).toBe(409)
        expect(checkout.body.message).toMatch(/^Some items you selected are sold out/)

        const removed = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/deleteItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId })
        // It was the only line and nothing was paid: the emptied cart goes.
        expect(removed.status).toBe(204)
        expect(await CartModel.findById(cartId)).toBeNull()
    })

    it("says so, as a 502, when PayPal won't create the order", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 1)
        mockedCreateOrder.mockRejectedValue(new Error("PayPal create order failed (500)"))

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/createCheckoutOrder`)
            .set("Cookie", customer.cookies)

        expect(res.status).toBe(502)
        expect(res.body.message).toBe("Could not create PayPal order")
    })

    it("returns 404 when the caller has no open splits", async () => {
        const { tableId, cartId, customer } = await scaffold()

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/createCheckoutOrder`)
            .set("Cookie", customer.cookies)

        expect(res.status).toBe(404)
        expect(mockedCreateOrder).not.toHaveBeenCalled()
    })
})

// --------------------------------------------------------------------------

describe("captureCheckout (POST /carts/tables/:tableId/:cartId/captureCheckout)", () => {
    it("captures an approved order, settles the caller's splits, and records the id", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold() // item qty 2
        await addSplit(customer.cookies, 2) // £6.00 due
        mockedGetOrder.mockResolvedValue(approvedOrder("6.00", `${cartId}:${customer.user._id}`))
        mockedCaptureOrder.mockResolvedValue(capturedOrder("6.00"))

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })

        expect(res.status).toBe(200)
        expect(mockedCaptureOrder).toHaveBeenCalledWith("ORDER-1")

        const cart = await CartModel.findById(cartId)
        expect(cart?.paypalOrderIds).toContain("ORDER-1")
        expect(cart?.split[0].splitStatus).toBe("closed")
        expect(cart?.items[0].qtyPayed).toBe(2)
        expect(cart?.status).toBe("closed")
    })

    it("rejects an order whose custom_id targets a different cart/payer with 402, without capturing", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 2)
        // Order minted for someone else / another cart.
        mockedGetOrder.mockResolvedValue(approvedOrder("6.00", "someone-elses-cart:someone-else"))

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })

        expect(res.status).toBe(402)
        expect(mockedCaptureOrder).not.toHaveBeenCalled()

        const cart = await CartModel.findById(cartId)
        expect(cart?.split[0].splitStatus).toBe("open")
    })

    it("rejects with 409 when the amount drifted after the order was created, without capturing", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 2) // £6.00 due now
        // Order was created earlier for £3.00 (caller since changed their selection).
        mockedGetOrder.mockResolvedValue(approvedOrder("3.00", `${cartId}:${customer.user._id}`))

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })

        expect(res.status).toBe(409)
        expect(mockedCaptureOrder).not.toHaveBeenCalled()
    })

    it("rejects with 409 when availability was lost before capture, without capturing", async () => {
        const { tableId, cartId, customer, menuId, addSplit } = await scaffold({ qty: 1 }) // one unit
        await addSplit(customer.cookies, 1) // caller owes £3.00 for the single unit
        // Another payer settled that unit in the meantime (qtyPayed bumped to 1).
        await CartModel.updateOne({ _id: cartId, "items.menuId": menuId }, { $set: { "items.$.qtyPayed": 1 } })
        mockedGetOrder.mockResolvedValue(approvedOrder("3.00", `${cartId}:${customer.user._id}`))

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })

        expect(res.status).toBe(409)
        expect(mockedCaptureOrder).not.toHaveBeenCalled()
    })

    it("rejects with 409 without capturing when the item sold out after the order was approved", async () => {
        const { owner, shopId, tableId, menuId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 1) // £3.00 due
        mockedGetOrder.mockResolvedValue(approvedOrder("3.00", `${cartId}:${customer.user._id}`))
        await request(app).put(`/shops/${shopId}/menu/${menuId}`).set("Cookie", owner.cookies).send({ available: false })

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })

        expect(res.status).toBe(409)
        expect(res.body.message).toMatch(/^Some items you selected are sold out/)
        expect(mockedCaptureOrder).not.toHaveBeenCalled()
        expect(mockedRefundCapture).not.toHaveBeenCalled()
    })

    it("rejects a replayed order id with 402 before verifying or capturing", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 2)
        // The id was already recorded on this cart (settled earlier).
        await CartModel.findByIdAndUpdate(cartId, { $set: { paypalOrderId: "ORDER-1" } })

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })

        expect(res.status).toBe(402)
        expect(mockedGetOrder).not.toHaveBeenCalled()
        expect(mockedCaptureOrder).not.toHaveBeenCalled()
    })

    it("refunds and returns 409 when a concurrent payer takes the units in the window after capture", async () => {
        await CartModel.syncIndexes()
        const { tableId, cartId, customer, menuId, addSplit, addNamedItem } = await scaffold({ qty: 1 }) // one unit
        // A second, unpaid item keeps the cart open after the first unit is taken.
        await addNamedItem("Tea", 1)

        await addSplit(customer.cookies, 1) // Alice owes £3.00 for the single unit

        // Bob holds an open split on the SAME unit (only reachable by racing past
        // addSplitItem's guard, injected here).
        const bob = await authFor("customer")
        await CartModel.findByIdAndUpdate(cartId, {
            $push: { split: { userId: bob.user._id, menuId, qty: 1, splitStatus: "open" } },
        })

        mockedGetOrder.mockResolvedValue(approvedOrder("3.00", `${cartId}:${customer.user._id}`))
        // During "capture", Bob settles the shared unit through a real version-bumping
        // save — so Alice's settle hits a VersionError, reloads, and finds no units left.
        mockedCaptureOrder.mockImplementation(async () => {
            const c = await CartModel.findById(cartId)
            if (!c) throw new Error("cart vanished")
            const bobSplit = c.split.find((s) => String(s.userId) === String(bob.user._id))
            if (bobSplit) bobSplit.splitStatus = "closed"
            const unit = c.items.find((i) => String(i.menuId) === String(menuId))
            if (unit) unit.qtyPayed += 1
            c.paypalOrderIds = [...(c.paypalOrderIds ?? []), "ORDER-BOB"]
            await c.save()
            return capturedOrder("3.00", { id: "ORDER-ALICE", captureId: "CAPTURE-ALICE" })
        })

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-ALICE" })

        expect(res.status).toBe(409)
        expect(mockedRefundCapture).toHaveBeenCalledTimes(1)
        expect(mockedRefundCapture).toHaveBeenCalledWith("CAPTURE-ALICE")

        const cart = await CartModel.findById(cartId)
        const unit = cart?.items.find((i) => String(i.menuId) === String(menuId))
        expect(unit?.qtyPayed).toBe(1) // only Bob's settlement, never Alice's
        expect(cart?.paypalOrderIds).not.toContain("ORDER-ALICE")
        expect(cart?.payments).toEqual([]) // a refunded capture leaves no payment record
    })

    it("refunds when saving the settlement fails after capture, instead of keeping the money", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 2)
        mockedGetOrder.mockResolvedValue(approvedOrder("6.00", `${cartId}:${customer.user._id}`))
        mockedCaptureOrder.mockResolvedValue(capturedOrder("6.00", { captureId: "CAPTURE-9" }))
        mockedRefundCapture.mockResolvedValue(undefined as never)
        // The database fails on the settlement save (not a version conflict).
        const save = jest.spyOn(CartModel.prototype, "save").mockRejectedValueOnce(new Error("db down"))
        const quiet = jest.spyOn(console, "error").mockImplementation(() => {})

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })
        save.mockRestore()
        quiet.mockRestore()

        expect(res.status).toBe(409)
        expect(res.body.message).toMatch(/your payment was refunded/)
        expect(mockedRefundCapture).toHaveBeenCalledWith("CAPTURE-9")
        const cart = await CartModel.findById(cartId)
        expect(cart?.split[0].splitStatus).toBe("open")
        expect(cart?.paypalOrderIds ?? []).toEqual([])
        expect(cart?.payments).toEqual([])
    })

    it("returns 500 (contact staff) when the post-capture refund itself fails", async () => {
        await CartModel.syncIndexes()
        const { tableId, cartId, customer, menuId, addSplit, addNamedItem } = await scaffold({ qty: 1 })
        await addNamedItem("Tea", 1)
        await addSplit(customer.cookies, 1)

        const bob = await authFor("customer")
        await CartModel.findByIdAndUpdate(cartId, {
            $push: { split: { userId: bob.user._id, menuId, qty: 1, splitStatus: "open" } },
        })

        mockedGetOrder.mockResolvedValue(approvedOrder("3.00", `${cartId}:${customer.user._id}`))
        mockedCaptureOrder.mockImplementation(async () => {
            const c = await CartModel.findById(cartId)
            if (!c) throw new Error("cart vanished")
            const bobSplit = c.split.find((s) => String(s.userId) === String(bob.user._id))
            if (bobSplit) bobSplit.splitStatus = "closed"
            const unit = c.items.find((i) => String(i.menuId) === String(menuId))
            if (unit) unit.qtyPayed += 1
            c.paypalOrderIds = [...(c.paypalOrderIds ?? []), "ORDER-BOB"]
            await c.save()
            return capturedOrder("3.00", { id: "ORDER-ALICE", captureId: "CAPTURE-ALICE" })
        })
        mockedRefundCapture.mockRejectedValue(new Error("PayPal refund failed (500)"))

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-ALICE" })

        expect(res.status).toBe(500)
        // The diner sees the order id to give staff, not "Generic Server Error".
        expect(res.body.message).toBe(
            "Payment captured but could not be settled or refunded — please contact staff (order ORDER-ALICE)")
        expect(mockedRefundCapture).toHaveBeenCalledTimes(1)
    })

    // What the diner is told when PayPal's answer to the capture is:
    const captureWith = async (answer: () => Promise<PayPalOrder>) => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 2) // £6.00 due
        mockedGetOrder.mockResolvedValue(approvedOrder("6.00", `${cartId}:${customer.user._id}`))
        mockedCaptureOrder.mockImplementation(answer)
        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })
        return { res, cart: await CartModel.findById(cartId) }
    }

    it("says nothing was charged (402) when PayPal refuses the capture", async () => {
        const { res, cart } = await captureWith(() =>
            Promise.reject(new PayPalCaptureRefused("PayPal order capture failed (422)")))

        expect(res.status).toBe(402)
        expect(cart?.split[0].splitStatus).toBe("open")
    })

    it("asks the diner to contact staff, not to pay again, when the capture gets no clear answer", async () => {
        const { res, cart } = await captureWith(() => Promise.reject(new Error("PayPal order capture failed (503)")))

        expect(res.status).toBe(502)
        expect(res.body.message).toBe(
            "We couldn't confirm your payment with PayPal — please contact staff before paying again (order ORDER-1)")
        // Nothing recorded, and nothing refunded: there may be nothing to refund.
        expect(cart?.split[0].splitStatus).toBe("open")
        expect(cart?.paypalOrderIds ?? []).not.toContain("ORDER-1")
        expect(mockedRefundCapture).not.toHaveBeenCalled()
    })

    it("says nothing was charged (402) when PayPal declines the capture", async () => {
        const declined = capturedOrder("6.00")
        declined.purchase_units![0].payments!.captures![0].status = "DECLINED"
        const { res } = await captureWith(async () => declined)

        expect(res.status).toBe(402)
    })
})

describe("a cart id used under another table's URL", () => {
    it("is refused on the split and checkout routes", async () => {
        const { owner, shopId, cartId, customer, menuId } = await scaffold()
        const otherTable = (
            await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name: "T2" })
        ).body._id

        const split = await request(app)
            .post(`/carts/${shopId}/tables/${otherTable}/${cartId}/addSplitItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        expect(split.status).toBe(404)
        expect((await CartModel.findById(cartId))?.split).toHaveLength(0)

        for (const step of ["decreaseSplitItem", "removeSplitItem"]) {
            const res = await request(app)
                .post(`/carts/${shopId}/tables/${otherTable}/${cartId}/${step}`)
                .set("Cookie", customer.cookies)
                .send({ menuId })
            expect(res.status).toBe(404)
        }

        const order = await request(app)
            .post(`/carts/tables/${otherTable}/${cartId}/createCheckoutOrder`)
            .set("Cookie", customer.cookies)
        expect(order.status).toBe(404)

        const capture = await request(app)
            .post(`/carts/tables/${otherTable}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })
        expect(capture.status).toBe(404)
        expect(mockedCreateOrder).not.toHaveBeenCalled()
        expect(mockedCaptureOrder).not.toHaveBeenCalled()
    })
})

describe("payment records", () => {
    // A settled £6 checkout of 2 × £3 Latte, captured as CAPTURE-7.
    const settle = async () => {
        const ctx = await scaffold()
        await ctx.addSplit(ctx.customer.cookies, 2)
        mockedGetOrder.mockResolvedValue(approvedOrder("6.00", `${ctx.cartId}:${ctx.customer.user._id}`))
        mockedCaptureOrder.mockResolvedValue(capturedOrder("6.00", { captureId: "CAPTURE-7" }))
        const res = await request(app)
            .post(`/carts/tables/${ctx.tableId}/${ctx.cartId}/captureCheckout`)
            .set("Cookie", ctx.customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })
        return { ...ctx, res }
    }

    it("records who paid what, when, at which price, and the capture to refund", async () => {
        const before = Date.now()
        const { cartId, customer, menuId, res } = await settle()
        expect(res.status).toBe(200)

        const cart = await CartModel.findById(cartId)
        expect(cart?.payments).toHaveLength(1)
        const payment = cart!.payments[0]
        expect(payment).toMatchObject({
            provider: "paypal",
            providerCheckoutId: "ORDER-1",
            providerPaymentId: "CAPTURE-7",
            currency: "GBP",
            amount: 6,
        })
        expect(String(payment.userId)).toBe(String(customer.user._id))
        expect(payment.paidAt.getTime()).toBeGreaterThanOrEqual(before)
        expect(cart!.toObject().payments[0].lines).toEqual([
            { menuId: expect.anything(), name: "Latte", qty: 2, unitPrice: 3, refundedQty: 0, category: "drinks" },
        ])
        expect(String(payment.lines[0].menuId)).toBe(String(menuId))
        // The closed split carries the price and time too.
        expect(cart?.split[0]).toMatchObject({ splitStatus: "closed", unitPrice: 3 })
        expect(cart?.split[0].paidAt?.getTime()).toBe(payment.paidAt.getTime())
    })

    it("keeps the price paid when the menu price changes afterwards", async () => {
        const { owner, shopId, menuId, tableId, res } = await settle()
        expect(res.status).toBe(200)
        await request(app).put(`/shops/${shopId}/menu/${menuId}`).set("Cookie", owner.cookies).send({ price: 9 })

        const cart = await request(app).get(`/carts/tables/${tableId}`)
        // The table's cart closed when fully paid; read it straight from the DB.
        expect(cart.status).toBe(404)
        const stored = await CartModel.findOne({ tableId }).populate("split.menuId")
        const split = stored!.split[0]
        expect(split.unitPrice).toBe(3)
        expect((split.menuId as unknown as { price: number }).price).toBe(9)
        expect(stored!.payments[0].lines[0].unitPrice).toBe(3)
    })

    it("never sends payment records to diners", async () => {
        const { tableId, cartId, customer, res } = await (async () => {
            // Keep the cart open after paying, so the public table view returns it.
            const ctx = await scaffold()
            await ctx.addNamedItem("Muffin", 1)
            await ctx.addSplit(ctx.customer.cookies, 2)
            mockedGetOrder.mockResolvedValue(approvedOrder("6.00", `${ctx.cartId}:${ctx.customer.user._id}`))
            mockedCaptureOrder.mockResolvedValue(capturedOrder("6.00", { captureId: "CAPTURE-7" }))
            const res = await request(app)
                .post(`/carts/tables/${ctx.tableId}/${ctx.cartId}/captureCheckout`)
                .set("Cookie", ctx.customer.cookies)
                .send({ paypalOrderId: "ORDER-1" })
            return { ...ctx, res }
        })()
        expect(res.status).toBe(200)
        expect((await CartModel.findById(cartId))?.payments).toHaveLength(1)

        const responses = [
            res,
            await request(app).get(`/carts/tables/${tableId}`),
            await request(app).get(`/carts/${cartId}`).set("Cookie", customer.cookies),
            await request(app).get("/carts").set("Cookie", customer.cookies),
        ]
        for (const r of responses) {
            expect(r.status).toBe(200)
            expect(r.body).not.toHaveProperty("payments")
            expect(JSON.stringify(r.body)).not.toContain("CAPTURE-7")
        }
        // What diners do get: the price paid on their closed split.
        expect(responses[1].body.split[0]).toMatchObject({ splitStatus: "closed", unitPrice: 3 })
    })
})

// --------------------------------------------------------------------------
// Multi-payer settlement: several diners paying for one cart.

describe("multi-payer settlement (via captureCheckout)", () => {
    it("declares paypalOrderIds as a unique, sparse index", () => {
        const options = CartModel.schema.path("paypalOrderIds").options
        expect(options.unique).toBe(true)
        expect(options.sparse).toBe(true)
    })

    it("rejects a duplicate paypalOrderId at the DB level (11000)", async () => {
        const { cartId } = await scaffold()
        await CartModel.syncIndexes()

        const cartA = await CartModel.findById(cartId)
        if (!cartA) throw new Error("cart not found")
        cartA.paypalOrderIds = ["ORDER-DUP"]
        await cartA.save()

        const { cartId: cartId2 } = await scaffold()
        const cartB = await CartModel.findById(cartId2)
        if (!cartB) throw new Error("cart not found")
        cartB.paypalOrderIds = ["ORDER-DUP"]

        await expect(cartB.save()).rejects.toMatchObject({ code: 11000 })
    })

    it("settles only the caller's splits, leaving another user's untouched", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold() // item qty 2
        const other = await authFor("customer")

        await addSplit(customer.cookies, 1) // caller owes £3.00
        await addSplit(other.cookies, 1) // another diner also has an open split

        mockedGetOrder.mockResolvedValue(approvedOrder("3.00", `${cartId}:${customer.user._id}`))
        mockedCaptureOrder.mockResolvedValue(capturedOrder("3.00"))

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })
        expect(res.status).toBe(200)

        const cart = await CartModel.findById(cartId)
        const mine = cart?.split.find((s) => String(s.userId) === String(customer.user._id))
        const theirs = cart?.split.find((s) => String(s.userId) === String(other.user._id))
        expect(mine?.splitStatus).toBe("closed")
        expect(theirs?.splitStatus).toBe("open")
        expect(cart?.items[0].qtyPayed).toBe(1) // only the caller's unit paid
        expect(cart?.status).toBe("open") // item qty 2, one still unpaid
    })

    it("records BOTH payers' order ids when two diners settle the same cart sequentially", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold() // item qty 2
        const other = await authFor("customer")

        await addSplit(customer.cookies, 1) // A owes £3.00
        await addSplit(other.cookies, 1) // B owes £3.00 (the other unit)

        mockedGetOrder.mockImplementation(async (orderId: string) =>
            orderId === "ORDER-A"
                ? approvedOrder("3.00", `${cartId}:${customer.user._id}`, { id: "ORDER-A" })
                : approvedOrder("3.00", `${cartId}:${other.user._id}`, { id: "ORDER-B" })
        )
        mockedCaptureOrder.mockImplementation(async (orderId: string) =>
            orderId === "ORDER-A"
                ? capturedOrder("3.00", { id: "ORDER-A", captureId: "CAPTURE-A" })
                : capturedOrder("3.00", { id: "ORDER-B", captureId: "CAPTURE-B" })
        )

        const resA = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-A" })
        expect(resA.status).toBe(200)

        const resB = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", other.cookies)
            .send({ paypalOrderId: "ORDER-B" })
        expect(resB.status).toBe(200)

        const cart = await CartModel.findById(cartId)
        expect(cart?.paypalOrderIds).toEqual(expect.arrayContaining(["ORDER-A", "ORDER-B"]))
        expect(cart?.items[0].qtyPayed).toBe(2)
        expect(cart?.status).toBe("closed")
        // One payment record per payer, each with its own capture.
        expect(cart?.payments.map((p) => [p.providerCheckoutId, p.providerPaymentId, String(p.userId), p.amount])).toEqual([
            ["ORDER-A", "CAPTURE-A", String(customer.user._id), 3],
            ["ORDER-B", "CAPTURE-B", String(other.user._id), 3],
        ])
    })

    it("settles on a busy table, where other diners' taps keep changing the cart while it saves", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 1)
        mockedGetOrder.mockResolvedValue(approvedOrder("3.00", `${cartId}:${customer.user._id}`))
        mockedCaptureOrder.mockResolvedValue(capturedOrder("3.00"))
        // Another write lands just before each of the first four saves.
        const realSave = CartModel.prototype.save
        let taps = 4
        const save = jest.spyOn(CartModel.prototype, "save").mockImplementation(async function (this: InstanceType<typeof CartModel>, ...args: unknown[]) {
            if (taps-- > 0) await CartModel.updateOne({ _id: this._id }, { $set: { updatedAt: new Date() } })
            return (realSave as (...a: unknown[]) => Promise<unknown>).apply(this, args)
        } as never)

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })
        save.mockRestore()

        expect(res.status).toBe(200)
        expect(mockedRefundCapture).not.toHaveBeenCalled()
        expect((await CartModel.findById(cartId))!.items[0].qtyPayed).toBe(1)
    })

    it("settles the payer's own selection when another diner unticks theirs during the capture", async () => {
        const { shopId, tableId, cartId, customer, addSplit } = await scaffold() // item qty 2
        const other = await authFor("customer")
        await addSplit(other.cookies, 1) // split[0]: the other diner's unit
        await addSplit(customer.cookies, 1) // split[1]: the payer's, £3.00

        mockedGetOrder.mockResolvedValue(approvedOrder("3.00", `${cartId}:${customer.user._id}`))
        // While PayPal takes the money, the other diner unticks: split[1] moves to split[0].
        mockedCaptureOrder.mockImplementation(async () => {
            const untick = await request(app)
                .post(`/carts/${shopId}/tables/${tableId}/${cartId}/removeSplitItem`)
                .set("Cookie", other.cookies)
                .send({ menuId: (await CartModel.findById(cartId))!.items[0].menuId })
            expect(untick.status).toBe(200)
            return capturedOrder("3.00")
        })

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })

        expect(res.status).toBe(200)
        const cart = await CartModel.findById(cartId)
        expect(cart!.split.map((s) => [String(s.userId), s.qty, s.splitStatus])).toEqual([
            [String(customer.user._id), 1, "closed"],
        ])
        expect(cart!.items[0].qtyPayed).toBe(1)
        expect(cart!.status).toBe("open") // the other unit is still unpaid
    })

    it("marks exactly what was charged when the payer grows their selection during the capture", async () => {
        const { shopId, tableId, cartId, menuId, customer, addSplit } = await scaffold({ qty: 3 })
        await addSplit(customer.cookies, 1) // £3.00 approved

        mockedGetOrder.mockResolvedValue(approvedOrder("3.00", `${cartId}:${customer.user._id}`))
        mockedCaptureOrder.mockImplementation(async () => {
            // Same diner, another tab: one more unit on the selection being paid.
            await request(app)
                .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
                .set("Cookie", customer.cookies)
                .send({ menuId, qty: 1 })
            return capturedOrder("3.00")
        })
        mockedRefundCapture.mockResolvedValue(undefined as never)

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })

        // The selection no longer matches the £3.00 charged: refunded, nothing marked paid.
        expect(res.status).toBe(409)
        expect(res.body.message).toBe("The table's cart changed while you were paying — your payment was refunded")
        expect(mockedRefundCapture).toHaveBeenCalledTimes(1)
        const cart = await CartModel.findById(cartId)
        expect(cart!.items[0].qtyPayed).toBe(0)
        expect(cart!.split.map((s) => [s.qty, s.splitStatus])).toEqual([[2, "open"]])
    })

    it("serialises two concurrent payers via optimistic concurrency, recording both ids", async () => {
        await CartModel.syncIndexes()
        const { tableId, cartId, customer, addSplit } = await scaffold() // item qty 2
        const other = await authFor("customer")

        await addSplit(customer.cookies, 1) // A owes £3.00
        await addSplit(other.cookies, 1) // B owes £3.00

        mockedGetOrder.mockImplementation(async (orderId: string) =>
            orderId === "ORDER-A"
                ? approvedOrder("3.00", `${cartId}:${customer.user._id}`, { id: "ORDER-A" })
                : approvedOrder("3.00", `${cartId}:${other.user._id}`, { id: "ORDER-B" })
        )
        mockedCaptureOrder.mockImplementation(async (orderId: string) =>
            orderId === "ORDER-A"
                ? capturedOrder("3.00", { id: "ORDER-A", captureId: "CAPTURE-A" })
                : capturedOrder("3.00", { id: "ORDER-B", captureId: "CAPTURE-B" })
        )

        // Fired together: one save wins, the other hits VersionError, reloads, and
        // retries against its own already-fetched capture — both must settle.
        const [resA, resB] = await Promise.all([
            request(app)
                .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
                .set("Cookie", customer.cookies)
                .send({ paypalOrderId: "ORDER-A" }),
            request(app)
                .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
                .set("Cookie", other.cookies)
                .send({ paypalOrderId: "ORDER-B" }),
        ])

        expect(resA.status).toBe(200)
        expect(resB.status).toBe(200)

        const cart = await CartModel.findById(cartId)
        expect(cart?.items[0].qtyPayed).toBe(2) // no lost update
        expect(cart?.paypalOrderIds).toEqual(expect.arrayContaining(["ORDER-A", "ORDER-B"]))
        expect(cart?.status).toBe("closed")
    })
})
