import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import mongoose from "mongoose"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"
import CartModel from "../services/carts/model"

// A shop with four tables and a £3 Latte, its manager, and a diner.
const scaffold = async () => {
    const owner = await authFor("shopMg")
    const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
    const tables: string[] = []
    for (const name of ["T1", "T2", "T3", "T4"]) {
        const res = await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name })
        tables.push(res.body._id)
    }
    const menuId = (
        await request(app)
            .post(`/shops/${shopId}/menu`)
            .set("Cookie", owner.cookies)
            .send({ name: "Latte", short_description: "Milky", price: 3, category: "drinks" })
    ).body._id
    const diner = await authFor("customer")

    const addItem = async (tableId: string, qty: number) =>
        (await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", diner.cookies).send({ menuId, qty }))
            .body._id as string
    const select = (tableId: string, cartId: string, qty: number) =>
        request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", diner.cookies)
            .send({ menuId, qty })
    // One unit paid at £3, as a settled checkout leaves it.
    const payOne = (cartId: string) =>
        CartModel.updateOne(
            { _id: cartId },
            {
                $set: { "items.0.qtyPayed": 1 },
                $push: {
                    split: { userId: diner.user._id, menuId, qty: 1, splitStatus: "closed", unitPrice: 3, paidAt: new Date() },
                    payments: {
                        provider: "paypal",
                        providerCheckoutId: "ORDER-1",
                        providerPaymentId: "CAPTURE-1",
                        currency: "GBP",
                        userId: diner.user._id,
                        paidAt: new Date(),
                        amount: 3,
                        lines: [{ menuId, name: "Latte", qty: 1, unitPrice: 3 }],
                    },
                },
            }
        )
    const status = () => request(app).get(`/shops/${shopId}/tables/status`).set("Cookie", owner.cookies)

    return { owner, shopId, tables, menuId, diner, addItem, select, payOne, status }
}

type Entry = { tableId: string; name: string; state: string; owed: number; paid: number; heldSince?: string; attention: string[] }
const byTable = (body: Entry[]) => Object.fromEntries(body.map((e) => [e.name, e]))

describe("GET /shops/:shopId/tables/status", () => {
    it("gives each table its state and money", async () => {
        const { shopId, owner, tables, menuId, addItem, select, payOne, status } = await scaffold()
        await addItem(tables[1], 1) // T2: ordering
        const t3 = await addItem(tables[2], 2) // T3: a selection held
        await select(tables[2], t3, 1)
        const t4 = await addItem(tables[3], 2) // T4: one of two paid
        await payOne(t4)

        const res = await status()
        expect(res.status).toBe(200)
        const t = byTable(res.body)
        expect(t.T1).toMatchObject({ tableId: tables[0], state: "free", owed: 0, paid: 0, attention: [] })
        expect(t.T2).toMatchObject({ state: "ordering", owed: 3, paid: 0 })
        expect(t.T3).toMatchObject({ state: "waitingToPay", owed: 6, paid: 0, attention: [] })
        expect(new Date(t.T3.heldSince!).getTime()).toBeGreaterThan(Date.now() - 60_000)
        expect(t.T4).toMatchObject({ state: "partlyPaid", owed: 3, paid: 3 })

        // A price edit changes what's owed, not what was paid.
        await request(app).put(`/shops/${shopId}/menu/${menuId}`).set("Cookie", owner.cookies).send({ price: 9 })
        expect(byTable((await status()).body).T4).toMatchObject({ owed: 9, paid: 3 })
    })

    it("flags sold-out items, long-held selections and duplicate carts", async () => {
        const { shopId, owner, tables, menuId, diner, addItem, select, status } = await scaffold()
        await addItem(tables[0], 1)
        await request(app).put(`/shops/${shopId}/menu/${menuId}`).set("Cookie", owner.cookies).send({ available: false })
        let t = byTable((await status()).body)
        expect(t.T1).toMatchObject({ attention: ["soldOut"], owed: 0 }) // sold-out units aren't owed
        await request(app).put(`/shops/${shopId}/menu/${menuId}`).set("Cookie", owner.cookies).send({ available: true })

        // A selection made 20 minutes ago is stale; one with no time (legacy) isn't.
        const t2 = await addItem(tables[1], 2)
        await select(tables[1], t2, 1)
        await CartModel.updateOne({ _id: t2 }, { $set: { "split.0.claimedAt": new Date(Date.now() - 20 * 60 * 1000) } })
        const t3 = await addItem(tables[2], 1)
        await CartModel.updateOne({ _id: t3 }, { $push: { split: { userId: diner.user._id, menuId, qty: 1, splitStatus: "open" } } })
        t = byTable((await status()).body)
        expect(t.T2.attention).toEqual(["staleSelection"])
        expect(t.T3).toMatchObject({ state: "waitingToPay", attention: [] })
        expect(t.T3.heldSince).toBeUndefined()

        // Two open carts for one table: only possible for data from before the
        // one-open-cart index, so the index is set aside to make one.
        await CartModel.init()
        await CartModel.collection.dropIndex("tableId_1")
        await addItem(tables[3], 1)
        await CartModel.collection.insertOne({
            userId: diner.user._id, tableId: tables[3], status: "open",
            items: [{ menuId: new mongoose.Types.ObjectId(menuId), qty: 1, qtyPayed: 0 }], split: [],
        })
        t = byTable((await status()).body)
        expect(t.T4.attention).toEqual(["duplicateCarts"])
        expect(t.T4.owed).toBe(6) // both carts' units are owed
        await CartModel.deleteMany({ tableId: tables[3] })
        await CartModel.syncIndexes()
    })
})

describe("GET /shops/:shopId/tables/:tableId/carts", () => {
    it("shows the open cart and today's closed ones with payments, naming diners by first name only", async () => {
        const { shopId, owner, tables, diner, addItem, select, payOne } = await scaffold()
        const open = await addItem(tables[0], 3)
        await select(tables[0], open, 1)
        await payOne(open)
        // Two finished carts: one closed an hour ago, one two days ago.
        const closedToday = await CartModel.create({ userId: diner.user._id, tableId: tables[0], status: "closed", items: [], split: [] })
        const closedOld = await CartModel.create({ userId: diner.user._id, tableId: tables[0], status: "closed", items: [], split: [] })
        await CartModel.collection.updateOne({ _id: closedOld._id }, { $set: { updatedAt: new Date(Date.now() - 48 * 3600 * 1000) } })

        const res = await request(app).get(`/shops/${shopId}/tables/${tables[0]}/carts`).set("Cookie", owner.cookies)

        expect(res.status).toBe(200)
        expect(res.body.open.map((c: { _id: string }) => c._id)).toEqual([open])
        expect(res.body.recentlyClosed.map((c: { _id: string }) => c._id)).toEqual([String(closedToday._id)])

        const cart = res.body.open[0]
        expect(cart.payments).toHaveLength(1)
        expect(cart.payments[0]).toMatchObject({ provider: "paypal", providerPaymentId: "CAPTURE-1", amount: 3 })
        expect(cart.payments[0].userId).toEqual({ _id: String(diner.user._id), name: diner.user.name })
        const openSelection = cart.split.find((s: { splitStatus: string }) => s.splitStatus === "open")
        expect(openSelection.userId).toEqual({ _id: String(diner.user._id), name: diner.user.name })
        expect(openSelection.claimedAt).toBeDefined()
        expect(cart.items[0].menuId).toMatchObject({ name: "Latte", price: 3 })
        expect(JSON.stringify(res.body)).not.toContain(diner.email)
    })

    it("is 404 for a table that isn't in the shop", async () => {
        const a = await scaffold()
        const b = await scaffold()
        const res = await request(app).get(`/shops/${a.shopId}/tables/${b.tables[0]}/carts`).set("Cookie", a.owner.cookies)
        expect(res.status).toBe(404)
    })
})

describe("manager table routes are for that shop's managers only", () => {
    it("refuses diners and other shops' managers", async () => {
        const { shopId, tables, diner } = await scaffold()
        const otherManager = await authFor("shopMg")
        for (const url of [`/shops/${shopId}/tables/status`, `/shops/${shopId}/tables/${tables[0]}/carts`]) {
            expect((await request(app).get(url)).status).toBe(401)
            expect((await request(app).get(url).set("Cookie", diner.cookies)).status).toBe(403)
            expect((await request(app).get(url).set("Cookie", otherManager.cookies)).status).toBe(403)
        }
    })

    it("still serves a table's public details under the same path", async () => {
        const { shopId, tables } = await scaffold()
        const res = await request(app).get(`/shops/${shopId}/tables/${tables[0]}`)
        expect(res.status).toBe(200)
        expect(res.body.name).toBe("T1")
    })
})
