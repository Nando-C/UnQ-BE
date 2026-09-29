import { jest, describe, it, expect } from "@jest/globals"
import mongoose from "mongoose"
import request from "supertest"
import "./setup"
import app from "../server"
import { authFor, cookiesFrom, loginCookies } from "./helpers"
import CartModel from "../services/carts/model"

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

    // Mark an item sold out the way a manager does (the card's toggle).
    const markSoldOut = (id: string = menuId) =>
        request(app)
            .put(`/shops/${shopId}/menu/${id}`)
            .set("Cookie", owner.cookies)
            .send({ available: false })

    return { owner, shopId, tableId, menuId, customer, markSoldOut }
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

    it("answers an expired or invalid token with 401 (for the FE to refresh), not the guest view", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()
        await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies).send({ menuId, qty: 1 })

        const stale = await request(app).get(`/carts/tables/${tableId}`).set("Cookie", ["accessToken=not-a-jwt"])
        expect(stale.status).toBe(401)
        // Without a token it's still the guest view.
        expect((await request(app).get(`/carts/tables/${tableId}`)).status).toBe(200)
    })

    it("shows the guest view to a diner whose account then signed in on another device", async () => {
        const { tableId, shopId, menuId, customer } = await scaffold()
        await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies).send({ menuId, qty: 1 })
        await new Promise((r) => setTimeout(r, 1100))
        await loginCookies(customer.email, customer.password) // the other device

        // Once the phone's 15-minute access token has run out, it goes through
        // the FE's steps: its read gets a 401, the refresh fails, and the read is
        // asked again with whatever cookies are left.
        const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60 * 1000)
        try {
            let jar = customer.cookies
            expect((await request(app).get(`/carts/tables/${tableId}`).set("Cookie", jar)).status).toBe(401)

            const refresh = await request(app).post("/auth/refreshToken").set("Cookie", jar)
            expect(refresh.status).toBe(401)
            const cleared = cookiesFrom(refresh).map((c) => c.split("=")[0])
            jar = jar.filter((c) => !cleared.includes(c.split("=")[0]))

            const again = await request(app).get(`/carts/tables/${tableId}`).set("Cookie", jar)
            expect(again.status).toBe(200)
            expect(again.body.items).toHaveLength(1)
        } finally {
            clock.mockRestore()
        }
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

    it("runs the split flow: add, then decrease", async () => {
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

        // Checkout itself (paying and closing the cart) is covered by
        // serverCheckout.test.ts's createCheckoutOrder/captureCheckout suites.
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

    // Concurrent claims. The availability check and the write used to be
    // separate steps, so requests arriving together all passed the check and
    // the split grew past the item's quantity.

    it("concurrent addSplitItem calls from one diner never claim more units than exist", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()
        const created = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 2 })
        const cartId = created.body._id
        const url = `/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`

        const results = await Promise.all(
            Array.from({ length: 6 }, () =>
                request(app).post(url).set("Cookie", customer.cookies).send({ menuId, qty: 1 })
            )
        )
        const statuses = results.map((r) => r.status).sort()
        expect(statuses).toEqual([200, 200, 409, 409, 409, 409])

        // One split entry for this diner, holding exactly the 2 units there are.
        const cart = await CartModel.findById(cartId).lean()
        const open = cart!.split.filter((s) => s.splitStatus === "open")
        expect(open).toHaveLength(1)
        expect(open[0].qty).toBe(2)
    })

    it("two diners racing for the last unit: exactly one gets it", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()
        const created = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        const cartId = created.body._id
        const url = `/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`
        const others = await Promise.all([authFor("customer"), authFor("customer"), authFor("customer")])

        const results = await Promise.all(
            [customer, ...others].map((diner) =>
                request(app).post(url).set("Cookie", diner.cookies).send({ menuId, qty: 1 })
            )
        )
        expect(results.filter((r) => r.status === 200)).toHaveLength(1)
        expect(results.filter((r) => r.status === 409)).toHaveLength(3)

        const cart = await CartModel.findById(cartId).lean()
        const claimed = cart!.split
            .filter((s) => s.splitStatus === "open")
            .reduce((sum, s) => sum + s.qty, 0)
        expect(claimed).toBe(1)
    })

    // ---------------------------------------------------------------------
    // S21: sold-out items

    it("rejects adding a sold-out item with 409 and leaves no cart behind", async () => {
        const { shopId, tableId, menuId, customer, markSoldOut } = await scaffold()
        expect((await markSoldOut()).status).toBe(200)

        const res = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        expect(res.status).toBe(409)
        expect(res.body.message).toBe("This item is sold out")

        const read = await request(app).get(`/carts/tables/${tableId}`)
        expect(read.status).toBe(404)
    })

    it("rejects adding another shop's menu item with 404", async () => {
        const { shopId, tableId, customer } = await scaffold()
        const otherShop = await scaffold()

        // A real, available item — but on a different shop's menu.
        const res = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId: otherShop.menuId, qty: 1 })
        expect(res.status).toBe(404)
        expect(res.body.message).toBe("Menu Item Not Found!")
    })

    it("refuses an order on a table that was deleted, or belongs to another shop", async () => {
        const { owner, shopId, tableId, menuId, customer } = await scaffold()
        const add = (table: string) =>
            request(app).post(`/carts/${shopId}/tables/${table}/addItem`).set("Cookie", customer.cookies).send({ menuId, qty: 1 })

        const otherShop = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Other" })).body._id
        const theirTable = (await request(app).post(`/shops/${otherShop}/tables`).set("Cookie", owner.cookies).send({ name: "T9" })).body._id
        expect((await add(theirTable)).status).toBe(404)

        await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies).expect(204)
        const res = await add(tableId)
        expect(res.status).toBe(404)
        expect(res.body.message).toBe("Table Not Found!")
        expect(await CartModel.countDocuments()).toBe(0)
    })

    it("includes menuId.available in cart responses", async () => {
        const { shopId, tableId, menuId, customer, markSoldOut } = await scaffold()
        await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })

        const before = await request(app).get(`/carts/tables/${tableId}`)
        expect(before.body.items[0].menuId.available).toBe(true)

        await markSoldOut()
        const after = await request(app).get(`/carts/tables/${tableId}`)
        expect(after.body.items[0].menuId.available).toBe(false)
    })

    it("blocks new split claims on a sold-out item but still lets a diner drop theirs", async () => {
        const { shopId, tableId, menuId, customer, markSoldOut } = await scaffold()
        const cartId = (
            await request(app)
                .post(`/carts/${shopId}/tables/${tableId}/addItem`)
                .set("Cookie", customer.cookies)
                .send({ menuId, qty: 2 })
        ).body._id
        const splitUrl = `/carts/${shopId}/tables/${tableId}/${cartId}`

        await request(app).post(`${splitUrl}/addSplitItem`).set("Cookie", customer.cookies).send({ menuId, qty: 1 })
        await markSoldOut()

        const more = await request(app).post(`${splitUrl}/addSplitItem`).set("Cookie", customer.cookies).send({ menuId, qty: 1 })
        expect(more.status).toBe(409)
        expect(more.body.message).toBe("This item is sold out")

        const dropped = await request(app).post(`${splitUrl}/removeSplitItem`).set("Cookie", customer.cookies).send({ menuId })
        expect(dropped.status).toBe(200)
        expect(dropped.body.split).toHaveLength(0)
    })

    it("deleteItem keeps the paid units of a partly-paid line, clears open splits, and closes a finished cart", async () => {
        const { shopId, tableId, menuId, customer, markSoldOut } = await scaffold()
        const cartId = (
            await request(app)
                .post(`/carts/${shopId}/tables/${tableId}/addItem`)
                .set("Cookie", customer.cookies)
                .send({ menuId, qty: 3 })
        ).body._id
        // Another diner holds the unpaid unit in an open split.
        const other = await authFor("customer")
        await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", other.cookies)
            .send({ menuId, qty: 1 })
        // Two of the three were already paid.
        await CartModel.updateOne({ _id: cartId, "items.menuId": menuId }, { $set: { "items.$.qtyPayed": 2 } })
        await markSoldOut()

        const res = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/deleteItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId })
        expect(res.status).toBe(200)
        expect(res.body.items).toHaveLength(1)
        expect(res.body.items[0].qty).toBe(2)
        expect(res.body.items[0].qtyPayed).toBe(2)
        expect(res.body.split).toHaveLength(0)
        // Nothing unpaid is left, so the table is finished.
        expect(res.body.status).toBe("closed")
    })

    it("deleteItem drops an unpaid line entirely and leaves the rest of the cart open", async () => {
        const { owner, shopId, tableId, menuId, customer } = await scaffold()
        const second = (
            await request(app)
                .post(`/shops/${shopId}/menu`)
                .set("Cookie", owner.cookies)
                .send({ name: "Tea", short_description: "Hot", price: 2, category: "drinks" })
        ).body._id
        const add = (id: string) =>
            request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", customer.cookies).send({ menuId: id, qty: 1 })
        await add(menuId)
        await add(second)

        const res = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/deleteItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId })
        expect(res.status).toBe(200)
        expect(res.body.items).toHaveLength(1)
        expect(res.body.items[0].menuId._id).toBe(second)
        expect(res.body.status).toBe("open")
    })

    it("deleteItem never overwrites another diner's order placed while it runs", async () => {
        const { owner, shopId, tableId, menuId, customer } = await scaffold()
        const tea = (
            await request(app)
                .post(`/shops/${shopId}/menu`)
                .set("Cookie", owner.cookies)
                .send({ name: "Tea", short_description: "Hot", price: 2, category: "drinks" })
        ).body._id
        const other = await authFor("customer")
        await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", customer.cookies).send({ menuId, qty: 1 })

        // Between deleteItem's read and its save, another diner orders a Tea.
        const save = CartModel.prototype.save
        let raced = false
        const spy = jest.spyOn(CartModel.prototype, "save").mockImplementation(async function (this: typeof CartModel.prototype) {
            if (!raced) {
                raced = true
                await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", other.cookies).send({ menuId: tea, qty: 1 })
            }
            return save.call(this)
        } as never)
        const res = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/deleteItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId })
        spy.mockRestore()

        expect(res.status).toBe(409)
        expect(res.body.message).toBe("The cart changed, please retry")
        const cart = await CartModel.findOne({ tableId })
        expect(cart!.items.map((i) => String(i.menuId))).toEqual([menuId, tea]) // the Tea survived
    })

    it("decreaseItem refuses to go below the paid + claimed units (409)", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()
        const cartId = (
            await request(app)
                .post(`/carts/${shopId}/tables/${tableId}/addItem`)
                .set("Cookie", customer.cookies)
                .send({ menuId, qty: 3 })
        ).body._id
        await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        await CartModel.updateOne({ _id: cartId, "items.menuId": menuId }, { $set: { "items.$.qtyPayed": 1 } })

        // 3 units, 1 paid + 1 claimed: dropping 2 would eat into them.
        const tooFar = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/removeItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 2 })
        expect(tooFar.status).toBe(409)

        // Dropping the one free unit is fine.
        const ok = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/removeItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        expect(ok.status).toBe(200)
        expect(ok.body.items[0].qty).toBe(2)
    })

    it("decreaseItem closes the cart when what's left is all paid, so the next party starts fresh", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()
        const cartId = (
            await request(app)
                .post(`/carts/${shopId}/tables/${tableId}/addItem`)
                .set("Cookie", customer.cookies)
                .send({ menuId, qty: 2 })
        ).body._id
        await CartModel.updateOne({ _id: cartId, "items.menuId": menuId }, { $set: { "items.$.qtyPayed": 1 } })

        // Take off the one unpaid unit: 1 unit left, 1 paid.
        const res = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/removeItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        expect(res.status).toBe(200)
        expect(res.body.status).toBe("closed")

        const next = await authFor("customer")
        const fresh = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", next.cookies)
            .send({ menuId, qty: 1 })
        expect(fresh.body._id).not.toBe(cartId)
    })

    it("decreaseItem closes the cart when it takes away the last unpaid line entirely", async () => {
        const { owner, shopId, tableId, menuId, customer } = await scaffold()
        const muffin = (await request(app).post(`/shops/${shopId}/menu`).set("Cookie", owner.cookies)
            .send({ name: "Muffin", short_description: "x", price: 2, category: "food" })).body._id
        const add = (id: string) => request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies).send({ menuId: id, qty: 1 })
        const cartId = (await add(menuId)).body._id
        await add(muffin)
        await CartModel.updateOne({ _id: cartId, "items.menuId": menuId }, { $set: { "items.$.qtyPayed": 1 } })

        // The Muffin line goes altogether; the paid Latte is all that's left.
        const res = await request(app).post(`/carts/${shopId}/tables/${tableId}/removeItem`)
            .set("Cookie", customer.cookies).send({ menuId: muffin, qty: 1 })
        expect(res.status).toBe(200)
        expect(res.body.status).toBe("closed")
        expect(res.body.items).toHaveLength(1)
    })

    it("decreaseItem keeps (and closes) an emptied cart that holds payment and refund records", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()
        const cartId = (await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies).send({ menuId, qty: 1 })).body._id
        // A paid line refunded since: the refund took its units out of the
        // cart, leaving its payment and refund records.
        const paymentId = new mongoose.Types.ObjectId()
        await CartModel.updateOne({ _id: cartId }, { $push: {
            payments: {
                _id: paymentId, provider: "paypal", providerCheckoutId: "ORDER-1", providerPaymentId: "CAP-1", currency: "GBP",
                userId: customer.user._id, paidAt: new Date(), amount: 2,
                lines: [{ menuId: new mongoose.Types.ObjectId(), name: "Muffin", qty: 1, unitPrice: 2, refundedQty: 1 }],
            },
            refunds: { paymentId, lines: [{ menuId: new mongoose.Types.ObjectId(), name: "Muffin", qty: 1 }], amount: 2, currency: "GBP", status: "completed", at: new Date() },
        } })

        const res = await request(app).post(`/carts/${shopId}/tables/${tableId}/removeItem`)
            .set("Cookie", customer.cookies).send({ menuId, qty: 1 })
        expect(res.status).toBe(200)
        const cart = await CartModel.findById(cartId)
        expect(cart).not.toBeNull()
        expect(cart!.status).toBe("closed")
        expect(cart!.payments).toHaveLength(1)
        expect(cart!.refunds).toHaveLength(1)
    })

    it("the database refuses a second open cart for a table, but not once the first is closed", async () => {
        await CartModel.init() // builds the one-open-cart-per-table index
        const cart = (tableId: string, status = "open") =>
            ({ userId: new mongoose.Types.ObjectId(), tableId, status, items: [], split: [] })

        await CartModel.create(cart("T1"))
        await expect(CartModel.create(cart("T1"))).rejects.toMatchObject({ code: 11000 })
        await CartModel.create(cart("T2")) // other tables are unaffected

        await CartModel.updateOne({ tableId: "T1" }, { status: "closed" })
        await CartModel.create(cart("T1"))
        expect(await CartModel.countDocuments({ tableId: "T1", status: "open" })).toBe(1)
    })

    it("addItem that loses the race for a table's first cart adds to the winner's cart", async () => {
        await CartModel.init()
        const { shopId, tableId, menuId, customer } = await scaffold()
        // The other diner's cart, holding the same item, lands just after this
        // request looked for one: the first lookup is made to miss it.
        await CartModel.create({ userId: new mongoose.Types.ObjectId(), tableId, status: "open", items: [{ menuId, qty: 1 }], split: [] })
        const lookup = jest.spyOn(CartModel, "findOneAndUpdate")
        lookup.mockImplementationOnce(() => CartModel.findOneAndUpdate({ _id: null }, {}) as never)

        const res = await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/addItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        // The missed lookup (and its stand-in query), the refused new cart,
        // then the lookup again, which finds the winner's line.
        const calls = lookup.mock.calls.length
        lookup.mockRestore()
        expect(calls).toBe(4)

        // Its own cart was refused (11000), so it retried onto the winner's.
        expect(res.status).toBe(200)
        const carts = await CartModel.find({ tableId, status: "open" })
        expect(carts).toHaveLength(1)
        expect(carts[0].items.map((i) => i.qty)).toEqual([2])
    })
})
