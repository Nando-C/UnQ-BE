import { jest, describe, it, expect } from "@jest/globals"
import request from "supertest"
import mongoose from "mongoose"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"
import CartModel from "../services/carts/model"

// A shop with one table and a £3 Latte and £2 Muffin, its manager, and two diners.
const scaffold = async () => {
    const owner = await authFor("shopMg")
    const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
    const tableId = (await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name: "T1" })).body._id
    const item = async (name: string, price: number) =>
        (await request(app).post(`/shops/${shopId}/menu`).set("Cookie", owner.cookies)
            .send({ name, short_description: "x", price, category: "drinks" })).body._id as string
    const latte = await item("Latte", 3)
    const muffin = await item("Muffin", 2)
    const ada = await authFor("customer")
    const bo = await authFor("customer")

    const add = async (who: typeof ada, menuId: string, qty: number) =>
        (await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", who.cookies).send({ menuId, qty }))
            .body._id as string
    const select = (who: typeof ada, cartId: string, menuId: string, qty: number) =>
        request(app).post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`).set("Cookie", who.cookies).send({ menuId, qty })
    // `qty` units of the first line paid, as a settled checkout leaves them.
    const pay = (cartId: string, menuId: string, qty: number) =>
        CartModel.updateOne({ _id: cartId, "items.menuId": menuId }, {
            $inc: { "items.$.qtyPayed": qty },
            $push: { split: { userId: ada.user._id, menuId, qty, splitStatus: "closed", unitPrice: 3 } },
        })
    const action = (cartId: string, name: string, body: object = {}, who = owner) =>
        request(app).post(`/shops/${shopId}/tables/${tableId}/carts/${cartId}/${name}`).set("Cookie", who.cookies).send(body)
    const tableCart = () => request(app).get(`/carts/tables/${tableId}`)

    return { owner, shopId, tableId, latte, muffin, ada, bo, add, select, pay, action, tableCart }
}

describe("releaseSelection", () => {
    it("frees one diner's selection and tells only that diner", async () => {
        const { latte, ada, bo, add, select, action, tableCart } = await scaffold()
        const cartId = await add(ada, latte, 3)
        await select(ada, cartId, latte, 2)
        await select(bo, cartId, latte, 1)

        const res = await action(cartId, "releaseSelection", { userId: String(ada.user._id) })
        expect(res.status).toBe(200)
        const open = res.body.split.filter((s: { splitStatus: string }) => s.splitStatus === "open")
        expect(open.map((s: { userId: { name: string } }) => s.userId.name)).toEqual([bo.user.name])
        expect(res.body.managerLog[0]).toMatchObject({ action: "releaseSelection", details: `${ada.user.name}: 2× Latte` })

        // Ada sees her note; Bo and the public table view don't.
        const forAda = await request(app).get(`/carts/${cartId}`).set("Cookie", ada.cookies)
        expect(forAda.body.notices.map((n: { message: string }) => n.message)).toEqual(["The staff released your selection of 2× Latte."])
        const forBo = await select(bo, cartId, latte, 0 + 1) // any of Bo's own calls
        expect(forBo.body.notices).toEqual([])
        expect((await tableCart()).body.notices).toEqual([])
        // The table's cart page (public) gives a signed-in diner their own notes,
        // and a stale login just the public view.
        const adaAtTable = await tableCart().set("Cookie", ada.cookies)
        expect(adaAtTable.body.notices.map((n: { message: string }) => n.message)).toEqual(["The staff released your selection of 2× Latte."])
        expect((await tableCart().set("Cookie", bo.cookies)).body.notices).toEqual([])
        const stale = await tableCart().set("Cookie", ["accessToken=not-a-jwt"])
        expect(stale.status).toBe(200)
        expect(stale.body.notices).toEqual([])
        expect((await tableCart()).body).not.toHaveProperty("managerLog")
    })

    it("frees only the selections of diners whose account is gone, for userId null", async () => {
        const { latte, ada, bo, add, select, action } = await scaffold()
        const cartId = await add(ada, latte, 3)
        await select(ada, cartId, latte, 2)
        await select(bo, cartId, latte, 1)
        await request(app).delete("/users/me").set("Cookie", ada.cookies).send({ currentPassword: ada.password })

        const res = await action(cartId, "releaseSelection", { userId: null, menuId: latte })
        expect(res.status).toBe(200)
        const open = res.body.split.filter((s: { splitStatus: string }) => s.splitStatus === "open")
        expect(open.map((s: { userId: { name: string } }) => s.userId.name)).toEqual([bo.user.name])
    })

    it("is 404 when there's nothing to release", async () => {
        const { latte, ada, add, action } = await scaffold()
        const cartId = await add(ada, latte, 1)
        expect((await action(cartId, "releaseSelection")).status).toBe(404)
    })
})

describe("removeItem", () => {
    it("takes out the unpaid units only, drops selections on them, and tells the table", async () => {
        const { latte, muffin, ada, bo, add, select, pay, action, tableCart } = await scaffold()
        const cartId = await add(ada, latte, 3)
        await add(ada, muffin, 1)
        await pay(cartId, latte, 1)
        await select(bo, cartId, latte, 1)

        const res = await action(cartId, "removeItem", { menuId: latte })
        expect(res.status).toBe(200)
        const line = res.body.items.find((i: { menuId: { _id: string } }) => i.menuId._id === latte)
        expect(line).toMatchObject({ qty: 1, qtyPayed: 1 })
        expect(res.body.split.filter((s: { splitStatus: string }) => s.splitStatus === "open")).toEqual([])

        const pub = await tableCart()
        expect(pub.body.status).toBe("open") // the Muffin is still to pay
        expect(pub.body.notices.map((n: { message: string }) => n.message)).toEqual(["The staff removed 2× Latte from this table's cart."])
    })

    it("refuses a line that's all paid, and an item not in the cart", async () => {
        const { latte, muffin, ada, add, pay, action } = await scaffold()
        const cartId = await add(ada, latte, 1)
        await add(ada, muffin, 1)
        await pay(cartId, latte, 1)
        expect((await action(cartId, "removeItem", { menuId: latte })).status).toBe(409)
        expect((await action(cartId, "removeItem", { menuId: String(new mongoose.Types.ObjectId()) })).status).toBe(404)
    })
})

describe("close", () => {
    it("drops unpaid units and selections, keeps paid ones, and the next party starts fresh", async () => {
        const { latte, muffin, ada, bo, add, select, pay, action, tableCart } = await scaffold()
        const cartId = await add(ada, latte, 2)
        await add(ada, muffin, 1)
        await pay(cartId, latte, 1)
        await select(bo, cartId, latte, 1)

        const res = await action(cartId, "close")
        expect(res.status).toBe(200)
        expect(res.body.deleted).toBe(false)
        expect(res.body.dropped).toEqual([
            { menuId: latte, name: "Latte", qty: 1 },
            { menuId: muffin, name: "Muffin", qty: 1 },
        ])
        const stored = await CartModel.findById(cartId)
        expect(stored?.status).toBe("closed")
        expect(stored?.items.map((i) => [String(i.menuId), i.qty, i.qtyPayed])).toEqual([[latte, 1, 1]])
        expect(stored?.split.every((s) => s.splitStatus === "closed")).toBe(true)
        expect(stored?.notices.map((n) => n.message)).toEqual(["The staff closed this table."])

        expect((await tableCart()).status).toBe(404)
        const next = await add(bo, latte, 1)
        expect(next).not.toBe(cartId)
    })

    it("deletes a cart where nothing was ever paid", async () => {
        const { latte, ada, add, action, tableCart } = await scaffold()
        const cartId = await add(ada, latte, 2)

        const res = await action(cartId, "close")
        expect(res.body).toEqual({ deleted: true, dropped: [{ menuId: latte, name: "Latte", qty: 2 }] })
        expect(await CartModel.findById(cartId)).toBeNull()
        expect((await tableCart()).status).toBe(404)
    })

    it("won't delete a never-paid cart a payment settled on meanwhile", async () => {
        const { latte, ada, add, action } = await scaffold()
        const cartId = await add(ada, latte, 2)
        // The payment lands between the manager's read and the delete.
        const deleteOne = CartModel.deleteOne.bind(CartModel)
        const spy = jest.spyOn(CartModel, "deleteOne").mockImplementationOnce(((filter: object) =>
            CartModel.updateOne({ _id: cartId }, { $set: { "items.0.qtyPayed": 2 }, $push: { payments: {
                provider: "paypal", providerCheckoutId: "ORDER-1", providerPaymentId: "CAP-1", currency: "GBP",
                userId: ada.user._id, paidAt: new Date(), amount: 6,
                lines: [{ menuId: latte, name: "Latte", qty: 2, unitPrice: 3 }],
            } } }).then(() => deleteOne(filter))) as never)

        const res = await action(cartId, "close")
        spy.mockRestore()
        expect(res.status).toBe(409)
        const cart = await CartModel.findById(cartId)
        expect(cart?.payments).toHaveLength(1)
    })

    it("fails with 409, changing nothing, when the cart changed underneath (e.g. a payment settling)", async () => {
        const { latte, ada, add, pay, action } = await scaffold()
        const cartId = await add(ada, latte, 2)
        await pay(cartId, latte, 1)
        // Another save lands between the manager's read and write.
        const save = CartModel.prototype.save
        const spy = jest.spyOn(CartModel.prototype, "save").mockImplementationOnce(async function (this: typeof CartModel.prototype) {
            await CartModel.updateOne({ _id: this._id }, { $inc: { __v: 1 } })
            return save.call(this)
        } as never)

        const res = await action(cartId, "close")
        spy.mockRestore()
        expect(res.status).toBe(409)
        expect((await CartModel.findById(cartId))?.status).toBe("open")
    })
})

describe("mergeInto", () => {
    it("moves an older duplicate cart's unpaid units and selections into the newest", async () => {
        const { tableId, latte, muffin, ada, bo, action } = await scaffold()
        // Two open carts for one table: only from before the one-open-cart
        // index, so it's set aside for this test.
        await CartModel.init()
        await CartModel.collection.dropIndex("tableId_1")
        const older = await CartModel.create({
            userId: ada.user._id, tableId, status: "open",
            items: [{ menuId: latte, qty: 3, qtyPayed: 1 }, { menuId: muffin, qty: 1, qtyPayed: 0 }],
            split: [
                { userId: ada.user._id, menuId: latte, qty: 1, splitStatus: "closed", unitPrice: 3 },
                { userId: bo.user._id, menuId: latte, qty: 1, splitStatus: "open" },
            ],
        })
        await new Promise((r) => setTimeout(r, 5)) // created after `older`
        const newer = await CartModel.create({
            userId: bo.user._id, tableId, status: "open",
            items: [{ menuId: latte, qty: 1, qtyPayed: 0 }], split: [],
        })

        expect((await action(String(newer._id), "mergeInto")).status).toBe(409) // only older into newer
        const res = await action(String(older._id), "mergeInto")
        expect(res.status).toBe(200)

        const target = await CartModel.findById(newer._id)
        expect(target?.items.map((i) => [String(i.menuId), i.qty, i.qtyPayed])).toEqual([[latte, 3, 0], [muffin, 1, 0]])
        expect(target?.split.map((s) => [String(s.userId), s.qty, s.splitStatus])).toEqual([[String(bo.user._id), 1, "open"]])
        const source = await CartModel.findById(older._id)
        expect(source?.status).toBe("closed")
        expect(source?.items.map((i) => [String(i.menuId), i.qty, i.qtyPayed])).toEqual([[latte, 1, 1]])

        expect((await action(String(newer._id), "mergeInto")).status).toBe(409) // one open cart left
        await CartModel.deleteMany({ tableId })
        await CartModel.syncIndexes()
    })
})

describe("deleting a table or shop with an open cart", () => {
    it("is refused until the cart is closed", async () => {
        const { owner, shopId, tableId, latte, ada, add, action } = await scaffold()
        const cartId = await add(ada, latte, 1)

        const table = await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)
        expect(table.status).toBe(409)
        const shop = await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)
        expect(shop.status).toBe(409)

        await action(cartId, "close")
        expect((await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)).status).toBe(204)
    })
})

describe("diner notices", () => {
    it("shows the table's diners the 5 newest from the last 2 hours", async () => {
        const { latte, ada, add, tableCart } = await scaffold()
        const cartId = await add(ada, latte, 1)
        const minutesAgo = (m: number) => new Date(Date.now() - m * 60000)
        await CartModel.updateOne({ _id: cartId }, {
            $push: {
                notices: [
                    { at: minutesAgo(180), message: "too old" },
                    ...[1, 2, 3, 4, 5, 6].map((m) => ({ at: minutesAgo(m), message: `${m} min ago` })),
                ],
            },
        })
        const res = await tableCart()
        expect(res.body.notices.map((n: { message: string }) => n.message)).toEqual(
            ["1 min ago", "2 min ago", "3 min ago", "4 min ago", "5 min ago"])
        expect(Object.keys(res.body.notices[0]).sort()).toEqual(["_id", "at", "message"])
    })
})

describe("manager actions are for that shop's managers, on that table's cart", () => {
    it("refuses diners, other shops' managers, and a cart from another table", async () => {
        const a = await scaffold()
        const cartId = await a.add(a.ada, a.latte, 1)
        const otherManager = await authFor("shopMg")
        for (const name of ["releaseSelection", "removeItem", "close", "mergeInto"]) {
            const body = name === "removeItem" ? { menuId: a.latte } : {}
            expect((await a.action(cartId, name, body, a.ada)).status).toBe(403)
            expect((await a.action(cartId, name, body, otherManager)).status).toBe(403)
        }
        const otherTable = (await request(app).post(`/shops/${a.shopId}/tables`).set("Cookie", a.owner.cookies).send({ name: "T2" })).body._id
        const res = await request(app)
            .post(`/shops/${a.shopId}/tables/${otherTable}/carts/${cartId}/close`)
            .set("Cookie", a.owner.cookies)
        expect(res.status).toBe(404)
        expect((await CartModel.findById(cartId))?.status).toBe("open")
    })
})
