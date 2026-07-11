import { jest, describe, it, expect, beforeEach } from "@jest/globals"

// Mock the PayPal client at the module boundary before the app is imported, so
// no network call is ever made and each test controls what the "order" looks like.
jest.mock("../lib/paypal", () => ({
    getOrder: jest.fn(),
}))

import request from "supertest"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"
import CartModel from "../services/carts/model"
import { getOrder, PayPalOrder } from "../lib/paypal"

const mockedGetOrder = jest.mocked(getOrder)

// A completed PayPal order whose single capture equals `value` in GBP.
const paypalOrder = (
    value: string,
    { status = "COMPLETED", currency = "GBP", id = "ORDER-1" } = {}
): PayPalOrder => ({
    id,
    status,
    purchase_units: [
        {
            amount: { currency_code: currency, value },
            payments: {
                captures: [{ status: "COMPLETED", amount: { currency_code: currency, value } }],
            },
        },
    ],
})

// Build a shop + table + £3 menu item and return everything a test needs to
// drive a split checkout. Adds the item to the customer's cart with the given
// qty; a split entry is added per-test so amounts can vary.
const scaffold = async () => {
    const owner = await authFor("shopMg")

    const shopRes = await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Split Cafe" })
    const shopId = shopRes.body._id

    const tableRes = await request(app)
        .post(`/shops/${shopId}/tables`)
        .set("Cookie", owner.cookies)
        .send({ name: "Table 1" })
    const tableId = tableRes.body._id

    const menuRes = await request(app)
        .post(`/shops/${shopId}/menu`)
        .set("Cookie", owner.cookies)
        .send({ name: "Latte", short_description: "Milky", price: 3, category: "drinks" })
    const menuId = menuRes.body._id

    const customer = await authFor("customer")

    const created = await request(app)
        .post(`/carts/${shopId}/tables/${tableId}/addItem`)
        .set("Cookie", customer.cookies)
        .send({ menuId, qty: 2 })
    const cartId = created.body._id

    const addSplit = (cookies: string[], qty: number) =>
        request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", cookies)
            .send({ menuId, qty })

    return { shopId, tableId, menuId, customer, cartId, addSplit }
}

describe("verified split checkout (POST /carts/tables/:tableId/:cartId/checkOutSplit)", () => {
    beforeEach(() => {
        mockedGetOrder.mockReset()
    })

    it("settles the caller's open splits and records the order id, closing the cart", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 2) // £6.00 due
        mockedGetOrder.mockResolvedValue(paypalOrder("6.00"))

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })

        expect(res.status).toBe(200)
        expect(mockedGetOrder).toHaveBeenCalledWith("ORDER-1")

        const cart = await CartModel.findById(cartId)
        expect(cart?.paypalOrderId).toBe("ORDER-1")
        expect(cart?.split[0].splitStatus).toBe("closed")
        expect(cart?.items[0].qtyPayed).toBe(2)
        expect(cart?.status).toBe("closed") // qty 2 fully paid
    })

    it("rejects a mismatched amount with 402 and mutates nothing", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 2) // £6.00 due
        mockedGetOrder.mockResolvedValue(paypalOrder("5.00")) // underpaid

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })

        expect(res.status).toBe(402)

        const cart = await CartModel.findById(cartId)
        expect(cart?.paypalOrderId).toBeUndefined()
        expect(cart?.split[0].splitStatus).toBe("open")
        expect(cart?.items[0].qtyPayed).toBe(0)
        expect(cart?.status).toBe("open")
    })

    it("rejects an order that is not COMPLETED with 402", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 2)
        mockedGetOrder.mockResolvedValue(paypalOrder("6.00", { status: "APPROVED" }))

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })

        expect(res.status).toBe(402)
        const cart = await CartModel.findById(cartId)
        expect(cart?.status).toBe("open")
    })

    it("rejects a reused paypalOrderId with 402 (replay protection)", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 2)
        mockedGetOrder.mockResolvedValue(paypalOrder("6.00"))

        const first = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })
        expect(first.status).toBe(200)

        // Any subsequent checkout referencing the same order id is rejected.
        const replay = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-1" })
        expect(replay.status).toBe(402)
    })

    it("settles only the caller's splits, leaving another user's untouched", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        const other = await authFor("customer")

        await addSplit(customer.cookies, 1) // caller owes £3.00
        await addSplit(other.cookies, 1) // another diner also has an open split

        mockedGetOrder.mockResolvedValue(paypalOrder("3.00"))

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
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
})
