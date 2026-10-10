import { jest, describe, it, expect } from "@jest/globals"
import request from "supertest"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"
import CartModel from "../services/carts/model"
import ShopModel from "../services/shops/model"

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
    // `qty` units of the line paid by Ada, as a settled checkout leaves them.
    const pay = (cartId: string, menuId: string, qty: number) =>
        CartModel.updateOne({ _id: cartId, "items.menuId": menuId }, {
            $inc: { "items.$.qtyPayed": qty },
            $push: { split: { userId: ada.user._id, menuId, qty, splitStatus: "closed", unitPrice: 3 } },
        })
    const action = (cartId: string, name: string, body: object = {}) =>
        request(app).post(`/shops/${shopId}/tables/${tableId}/carts/${cartId}/${name}`).set("Cookie", owner.cookies).send(body)
    const tableCartFor = (who?: typeof ada) => {
        const req = request(app).get(`/carts/tables/${tableId}`)
        return who ? req.set("Cookie", who.cookies) : req
    }
    const bin = (who: typeof ada, menuId: string) =>
        request(app).post(`/carts/${shopId}/tables/${tableId}/deleteItem`).set("Cookie", who.cookies).send({ menuId })
    const deleteTable = () => request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)

    return { owner, shopId, tableId, latte, muffin, ada, bo, add, select, pay, action, tableCartFor, bin, deleteTable }
}

const messages = (res: request.Response) => (res.body.notices as { message: string }[]).map((n) => n.message)

describe("notes from a closed cart", () => {
    it("reach the diners who took part, not someone new at the table or a guest", async () => {
        const t = await scaffold()
        const cartId = await t.add(t.ada, t.latte, 2)
        await t.pay(cartId, t.latte, 1)
        expect((await t.action(cartId, "close")).status).toBe(200)

        const ada = await t.tableCartFor(t.ada)
        expect(ada.status).toBe(404)
        expect(ada.body.message).toBe("Cart Not Found!")
        expect(messages(ada)).toEqual(["The staff closed this table."])

        const newcomer = await authFor("customer")
        expect(messages(await t.tableCartFor(newcomer))).toEqual([])
        expect(messages(await t.tableCartFor())).toEqual([])
    })

    it("reach a diner whose only part was a selection the close dropped, once", async () => {
        const t = await scaffold()
        const cartId = await t.add(t.ada, t.latte, 3)
        await t.pay(cartId, t.latte, 1)
        await t.select(t.bo, cartId, t.latte, 1)
        expect((await t.action(cartId, "close")).status).toBe(200)

        expect(messages(await t.tableCartFor(t.bo))).toEqual(["The staff closed this table."])
        expect(messages(await t.tableCartFor(t.ada))).toEqual(["The staff closed this table."])
    })

    it("stop once the table has a new open cart, which starts without them", async () => {
        const t = await scaffold()
        const first = await t.add(t.ada, t.latte, 1)
        await t.pay(first, t.latte, 1)
        await t.action(first, "close")

        const second = await t.add(t.ada, t.muffin, 1)
        expect(second).not.toBe(first)
        const res = await t.tableCartFor(t.ada)
        expect(res.status).toBe(200)
        expect(messages(res)).toEqual([])
    })
})

describe("a cart emptied of everything", () => {
    it("by the diner's bin goes, so the table is free and can be deleted", async () => {
        const t = await scaffold()
        const cartId = await t.add(t.ada, t.latte, 1)

        const res = await t.bin(t.ada, t.latte)
        expect(res.status).toBe(204)
        expect(await CartModel.findById(cartId)).toBeNull()
        expect((await t.tableCartFor(t.ada)).status).toBe(404)
        expect((await t.deleteTable()).status).toBe(204)
    })

    it("by the bin, after a manager acted on it, closes and keeps the record", async () => {
        const t = await scaffold()
        const cartId = await t.add(t.ada, t.latte, 2)
        await t.select(t.bo, cartId, t.latte, 1)
        await t.action(cartId, "releaseSelection", {})

        expect((await t.bin(t.ada, t.latte)).status).toBe(200)
        const cart = await CartModel.findById(cartId)
        expect(cart?.status).toBe("closed")
        expect(cart?.managerLog).toHaveLength(1)
        expect((await t.deleteTable()).status).toBe(204)
    })

    it("by the manager's Remove closes, and the diners who had it learn why", async () => {
        const t = await scaffold()
        const cartId = await t.add(t.ada, t.latte, 2)
        await t.select(t.bo, cartId, t.latte, 1)

        const res = await t.action(cartId, "removeItem", { menuId: t.latte })
        expect(res.status).toBe(200)
        expect(res.body.status).toBe("closed")
        expect((await t.deleteTable()).status).toBe(204)

        const note = "The staff removed 2× Latte from this table's cart."
        expect(messages(await t.tableCartFor(t.ada))).toEqual([note])
        expect(messages(await t.tableCartFor(t.bo))).toEqual([note])
        expect(messages(await t.tableCartFor(await authFor("customer")))).toEqual([])
    })

    it("keeps other lines and stays open when something else is left", async () => {
        const t = await scaffold()
        const cartId = await t.add(t.ada, t.latte, 1)
        await t.add(t.ada, t.muffin, 1)

        const res = await t.bin(t.ada, t.latte)
        expect(res.status).toBe(200)
        expect(res.body.status).toBe("open")
        expect((await CartModel.findById(cartId))?.items).toHaveLength(1)
    })
})

describe("table names", () => {
    it("two creates of one name at once make one table", async () => {
        const t = await scaffold()
        const create = () => request(app).post(`/shops/${t.shopId}/tables`).set("Cookie", t.owner.cookies).send({ name: "Patio" })
        // Every shop lookup is slowed down, so requests arriving together
        // overlap: a name check made as a separate lookup would pass for all
        // of them before any adds its table.
        const realFindOne = ShopModel.findOne.bind(ShopModel)
        const slowed = jest.spyOn(ShopModel, "findOne").mockImplementation(((...args: Parameters<typeof realFindOne>) => {
            const query = realFindOne(...args)
            const exec = query.exec.bind(query)
            query.exec = (async () => {
                await new Promise((r) => setTimeout(r, 100))
                return exec()
            }) as never
            return query
        }) as never)

        const statuses = (await Promise.all([create(), create(), create()])).map((r) => r.status).sort()
        slowed.mockRestore()
        expect(statuses).toEqual([200, 400, 400])
        const tables = (await request(app).get(`/shops/${t.shopId}/tables`).set("Cookie", t.owner.cookies)).body
        expect(tables.filter((x: { name: string }) => x.name === "Patio")).toHaveLength(1)
    })

    it("a rename answers 404 for a table that isn't there, and renames the right one", async () => {
        const t = await scaffold()
        const other = (await request(app).post(`/shops/${t.shopId}/tables`).set("Cookie", t.owner.cookies).send({ name: "T2" })).body._id
        const rename = (id: string, name: string) =>
            request(app).put(`/shops/${t.shopId}/tables/${id}`).set("Cookie", t.owner.cookies).send({ name })

        expect((await rename("not-an-id", "X")).status).toBe(404)
        expect((await rename("0123456789abcdef01234567", "X")).status).toBe(404)
        const res = await rename(other, "Terrace")
        expect(res.status).toBe(200)
        expect(res.body.map((x: { _id: string; name: string }) => [String(x._id), x.name])).toEqual([
            [String(t.tableId), "T1"], [String(other), "Terrace"],
        ])
    })
})
