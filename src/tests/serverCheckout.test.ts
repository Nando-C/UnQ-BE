import { jest, describe, it, expect, beforeEach } from "@jest/globals"

// Mock the PayPal client at the module boundary before the app is imported, so
// no network call is ever made and each test controls the whole PayPal surface.
jest.mock("../lib/paypal", () => ({
    getOrder: jest.fn(),
    createOrder: jest.fn(),
    captureOrder: jest.fn(),
    refundCapture: jest.fn(),
}))

import request from "supertest"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"
import CartModel from "../services/carts/model"
import { getOrder, createOrder, captureOrder, refundCapture, PayPalOrder } from "../lib/paypal"

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
        expect(mockedRefundCapture).toHaveBeenCalledTimes(1)
    })
})
