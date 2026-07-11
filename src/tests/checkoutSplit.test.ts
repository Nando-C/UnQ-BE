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
        expect(cart?.paypalOrderIds).toContain("ORDER-1")
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
        expect(cart?.paypalOrderIds).toBeUndefined()
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

    it("returns 402 via the DB-level guard when two checkouts race past the pre-check", async () => {
        await CartModel.syncIndexes()

        const first = await scaffold()
        await first.addSplit(first.customer.cookies, 2) // £6.00 due

        const second = await scaffold()
        await second.addSplit(second.customer.cookies, 2) // £6.00 due

        mockedGetOrder.mockResolvedValue(paypalOrder("6.00"))

        const [resA, resB] = await Promise.all([
            request(app)
                .post(`/carts/tables/${first.tableId}/${first.cartId}/checkOutSplit`)
                .set("Cookie", first.customer.cookies)
                .send({ paypalOrderId: "ORDER-RACE" }),
            request(app)
                .post(`/carts/tables/${second.tableId}/${second.cartId}/checkOutSplit`)
                .set("Cookie", second.customer.cookies)
                .send({ paypalOrderId: "ORDER-RACE" }),
        ])

        const statuses = [resA.status, resB.status].sort()
        expect(statuses).toEqual([200, 402])
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

    it("records BOTH payers' order ids when two diners settle the same cart sequentially", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold() // item qty 2
        const other = await authFor("customer")

        await addSplit(customer.cookies, 1) // A owes £3.00
        await addSplit(other.cookies, 1) // B owes £3.00 (the other unit)

        mockedGetOrder.mockResolvedValue(paypalOrder("3.00"))

        const resA = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "ORDER-A" })
        expect(resA.status).toBe(200)

        const resB = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
            .set("Cookie", other.cookies)
            .send({ paypalOrderId: "ORDER-B" })
        expect(resB.status).toBe(200)

        const cart = await CartModel.findById(cartId)
        expect(cart?.paypalOrderIds).toEqual(expect.arrayContaining(["ORDER-A", "ORDER-B"]))
        expect(cart?.items[0].qtyPayed).toBe(2)
        expect(cart?.status).toBe("closed")
    })

    it("serialises two concurrent payers via optimistic concurrency, recording both ids", async () => {
        await CartModel.syncIndexes()
        const { tableId, cartId, customer, addSplit } = await scaffold() // item qty 2
        const other = await authFor("customer")

        await addSplit(customer.cookies, 1) // A owes £3.00
        await addSplit(other.cookies, 1) // B owes £3.00

        mockedGetOrder.mockResolvedValue(paypalOrder("3.00"))

        // Fired together: one save wins, the other hits VersionError, reloads, and
        // retries against the already-fetched order — both must end up settled.
        const [resA, resB] = await Promise.all([
            request(app)
                .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
                .set("Cookie", customer.cookies)
                .send({ paypalOrderId: "ORDER-A" }),
            request(app)
                .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
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

    it("rejects a second payer over-settling a single unit at checkout with 409, mutating nothing", async () => {
        const owner = await authFor("shopMg")
        const shopRes = await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Split Cafe" })
        const shopId = shopRes.body._id
        const tableRes = await request(app)
            .post(`/shops/${shopId}/tables`)
            .set("Cookie", owner.cookies)
            .send({ name: "Table 1" })
        const tableId = tableRes.body._id

        const makeItem = (name: string) =>
            request(app)
                .post(`/shops/${shopId}/menu`)
                .set("Cookie", owner.cookies)
                .send({ name, short_description: "x", price: 3, category: "drinks" })
        const menuIdX = (await makeItem("Latte")).body._id
        const menuIdY = (await makeItem("Tea")).body._id

        const alice = await authFor("customer")
        const created = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", alice.cookies)
            .send({ menuId: menuIdX, qty: 1 })
        const cartId = created.body._id
        // A second, unpaid item keeps the cart open once X is settled.
        await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", alice.cookies)
            .send({ menuId: menuIdY, qty: 1 })

        // Alice legitimately splits the single X unit.
        await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", alice.cookies)
            .send({ menuId: menuIdX, qty: 1 })

        // Bob ends up with an open split on the SAME unit — only reachable by
        // racing past the addSplitItem pre-check, injected here to reproduce it.
        const bob = await authFor("customer")
        await CartModel.findByIdAndUpdate(cartId, {
            $push: { split: { userId: bob.user._id, menuId: menuIdX, qty: 1, splitStatus: "open" } },
        })

        mockedGetOrder.mockResolvedValue(paypalOrder("3.00"))

        const aliceRes = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
            .set("Cookie", alice.cookies)
            .send({ paypalOrderId: "ORDER-ALICE" })
        expect(aliceRes.status).toBe(200)

        const bobRes = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
            .set("Cookie", bob.cookies)
            .send({ paypalOrderId: "ORDER-BOB" })
        expect(bobRes.status).toBe(409)

        const cart = await CartModel.findById(cartId)
        const xItem = cart?.items.find((i) => String(i.menuId) === String(menuIdX))
        expect(xItem?.qtyPayed).toBe(1) // only Alice's unit, never Bob's
        const bobSplit = cart?.split.find((s) => String(s.userId) === String(bob.user._id))
        expect(bobSplit?.splitStatus).toBe("open") // untouched
        expect(cart?.paypalOrderIds).not.toContain("ORDER-BOB")
    })

    it("still 402s on replay when the order id lives in the legacy scalar field", async () => {
        const { tableId, cartId, customer, addSplit } = await scaffold()
        await addSplit(customer.cookies, 1)

        // Simulate a cart settled before multi-payer support: id in the scalar.
        await CartModel.findByIdAndUpdate(cartId, { $set: { paypalOrderId: "LEGACY-1" } })

        mockedGetOrder.mockResolvedValue(paypalOrder("3.00"))

        const res = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplit`)
            .set("Cookie", customer.cookies)
            .send({ paypalOrderId: "LEGACY-1" })
        expect(res.status).toBe(402)
    })
})
