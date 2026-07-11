import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"

// Build a shop + table + menu item owned by a shopMg, plus a customer to order.
const scaffold = async () => {
    const owner = await authFor("shopMg")

    const shopRes = await request(app)
        .post("/shops")
        .set("Cookie", owner.cookies)
        .send({ name: "Cart Cafe" })
    const shopId = shopRes.body._id

    const tableRes = await request(app)
        .post(`/shops/${shopId}/tables`)
        .set("Cookie", owner.cookies)
        .send({ name: "Table 1" })
    const tableId = tableRes.body._id

    const menuRes = await request(app)
        .post(`/shops/${shopId}/menu`)
        .set("Cookie", owner.cookies)
        .send({
            name: "Latte",
            short_description: "Milky",
            price: 3,
            category: "drinks",
        })
    const menuId = menuRes.body._id

    const customer = await authFor("customer")

    return { shopId, tableId, menuId, customer }
}

describe("carts", () => {
    it("creates a cart on first addItem and increments qty on repeat", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()
        const url = `/carts/${shopId}/tables/${tableId}/addItem`

        const first = await request(app)
            .post(url)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        expect(first.status).toBe(200)
        expect(first.body.items).toHaveLength(1)
        expect(first.body.items[0].qty).toBe(1)

        const second = await request(app)
            .post(url)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 2 })
        expect(second.status).toBe(200)
        expect(second.body.items).toHaveLength(1)
        expect(second.body.items[0].qty).toBe(3)
    })

    it("removes the item at zero qty and deletes the cart when empty", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()

        await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })

        const res = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/removeItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        expect(res.status).toBe(204)

        // The now-empty cart is gone.
        const gone = await request(app)
            .get(`/carts/tables/${tableId}`)
            .set("Cookie", customer.cookies)
        expect(gone.status).toBe(404)
    })

    it("shares one open cart per table: a second user joins it, not a duplicate", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()
        const url = `/carts/${shopId}/tables/${tableId}/addItem`

        const first = await request(app)
            .post(url)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        expect(first.status).toBe(200)

        const other = await authFor("customer")
        const second = await request(app)
            .post(url)
            .set("Cookie", other.cookies)
            .send({ menuId, qty: 2 })
        expect(second.status).toBe(200)
        expect(second.body._id).toBe(first.body._id)
        expect(second.body.items).toHaveLength(1)
        expect(second.body.items[0].qty).toBe(3)

        // getTableCart resolves to that same shared cart.
        const read = await request(app).get(`/carts/tables/${tableId}`)
        expect(read.status).toBe(200)
        expect(read.body._id).toBe(first.body._id)
    })

    it("forbids reading another user's cart (S5 authorization)", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()

        const created = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        const cartId = created.body._id

        // Owner can read it.
        const ownRead = await request(app)
            .get(`/carts/${cartId}`)
            .set("Cookie", customer.cookies)
        expect(ownRead.status).toBe(200)

        // A different user cannot.
        const other = await authFor("customer")
        const otherRead = await request(app)
            .get(`/carts/${cartId}`)
            .set("Cookie", other.cookies)
        expect(otherRead.status).toBe(404)
    })

    it("runs the split flow: add, decrease, then checkout closes the cart", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()

        const created = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 2 })
        const cartId = created.body._id

        // add a split item for this user
        const added = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 2 })
        expect(added.status).toBe(200)
        expect(added.body.split).toHaveLength(1)
        expect(added.body.split[0].qty).toBe(2)

        // decreaseSplitItem drops the qty by one
        const decreased = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/decreaseSplitItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId })
        expect(decreased.status).toBe(200)
        expect(decreased.body.split[0].qty).toBe(1)

        // checkout pays for both units of the item -> cart closes
        const checkout = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/checkOutSplitItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 2 })
        expect(checkout.status).toBe(200)
        expect(checkout.body.status).toBe("closed")
    })

    it("rejects an addSplitItem that would claim more units than the item has (409)", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()

        const created = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 }) // only one unit exists
        const cartId = created.body._id

        const over = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 2 })
        expect(over.status).toBe(409)
        expect(over.body.message).toBe("Not enough units left to split")

        // A second diner can't grab the one unit already claimed either.
        await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 }) // caller legitimately claims the single unit

        const other = await authFor("customer")
        const contested = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", other.cookies)
            .send({ menuId, qty: 1 })
        expect(contested.status).toBe(409)
    })
})
