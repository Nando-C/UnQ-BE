import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import mongoose from "mongoose"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"
import ShopModel from "../services/shops/model"
import MenuModel from "../services/menus/model"
import { browsePipeline } from "../services/shops/controllers/shopControllers"

const browse = (query: object = {}) => request(app).get("/shops/browse").query(query)
const names = (res: { body: { shops: { name: string }[] } }) => res.body.shops.map((s) => s.name)

// Shops created in this order, so oldest first is this order.
const shops = async (...list: { name: string; bio?: string }[]) => {
    const created = []
    for (const shop of list) created.push(await ShopModel.create({ ...shop, shopMg: [new mongoose.Types.ObjectId()] }))
    return created
}

describe("GET /shops/browse", () => {
    it("pages through the shops oldest first, without their menus or tables", async () => {
        const [a, b, , d] = await shops({ name: "A", bio: "first" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" })
        await ShopModel.updateOne({ _id: a._id }, { $push: { tables: { name: "T1" }, deletedTables: { name: "T0", deletedAt: new Date() } } })

        const first = await browse({ limit: 2 })
        expect(first.status).toBe(200)
        expect(first.body.shops[0]).toEqual({ _id: String(a._id), name: "A", bio: "first", cover: a.cover })
        expect(names(first)).toEqual(["A", "B"])
        expect(first.body.next).toBe(String(b._id))

        const second = await browse({ limit: 2, cursor: first.body.next })
        expect(names(second)).toEqual(["C", "D"])
        expect(second.body.next).toBe(String(d._id))

        const last = await browse({ limit: 2, cursor: second.body.next })
        expect(names(last)).toEqual(["E"])
        expect(last.body.next).toBeNull()
    })

    it("gives 20 by default, and no next page when they fit exactly", async () => {
        await shops(...Array.from({ length: 21 }, (_, i) => ({ name: `Shop ${i}` })))
        const first = await browse()
        expect(first.body.shops).toHaveLength(20)
        expect(first.body.next).not.toBeNull()

        await ShopModel.deleteOne({ name: "Shop 20" })
        const exact = await browse()
        expect(exact.body.shops).toHaveLength(20)
        expect(exact.body.next).toBeNull()
    })

    it("gives a shop stored without a cover the default one, as the other routes do", async () => {
        await ShopModel.collection.insertOne({ name: "Bare", shopMg: [], menu: [], tables: [] })
        const [listed] = (await browse()).body.shops

        expect(listed.cover).toBe((await request(app).get(`/shops/${listed._id}`)).body.cover)
        expect(listed.cover).toMatch(/^https:/)
        expect(listed).not.toHaveProperty("bio")
    })

    it("answers an empty list when there are no shops", async () => {
        const res = await browse()
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ shops: [], next: null })
    })

    it("searches names, bios and current menu items' names, case aside, and pages the results", async () => {
        const { cookies } = await authFor("shopMg")
        const created = await request(app).post("/shops").set("Cookie", cookies).send({ name: "Bean There" })
        const shopId = created.body._id
        const addItem = async (name: string) =>
            (await request(app)
                .post(`/shops/${shopId}/menu`)
                .set("Cookie", cookies)
                .send({ name, short_description: "x", price: 3, category: "food" })).body._id as string
        await addItem("Lemon Drizzle")
        const scone = await addItem("Cheese Scone")
        await shops({ name: "The Drizzle Bar" }, { name: "Tea Room", bio: "lemon tarts on Sundays" }, { name: "Elsewhere" })

        expect(names(await browse({ q: "lemon" }))).toEqual(["Bean There", "Tea Room"])
        expect(names(await browse({ q: "  DRIZZLE " }))).toEqual(["Bean There", "The Drizzle Bar"])
        expect(names(await browse({ q: "scone" }))).toEqual(["Bean There"])

        // A deleted item is kept (for carts that hold it), but no longer matches.
        expect((await request(app).delete(`/shops/${shopId}/menu/${scone}`).set("Cookie", cookies)).status).toBe(204)
        expect((await browse({ q: "scone" })).body).toEqual({ shops: [], next: null })

        const page = await browse({ q: "lemon", limit: 1 })
        expect(names(page)).toEqual(["Bean There"])
        const rest = await browse({ q: "lemon", limit: 1, cursor: page.body.next })
        expect(names(rest)).toEqual(["Tea Room"])
        expect(rest.body.next).toBeNull()
    })

    it("matches the search text literally", async () => {
        await shops({ name: "A+B (Cafe)" }, { name: "AAB Cafe" }, { name: "Plain" })

        expect(names(await browse({ q: "a+b (" }))).toEqual(["A+B (Cafe)"])
        expect(names(await browse({ q: ".*" }))).toEqual([])
        expect(names(await browse({ q: "\\" }))).toEqual([])
    })

    it("refuses a query it can't read (400)", async () => {
        for (const query of [{ limit: 0 }, { limit: 51 }, { limit: "2.5" }, { limit: "lots" }, { limit: "0x10" }, { limit: "1e1" }, { cursor: "nope" }, { q: ["a", "b"] }, { q: "x".repeat(101) }]) {
            const res = await browse(query)
            expect([JSON.stringify(query), res.status, res.body.message]).toEqual([JSON.stringify(query), 400, "Validation failed"])
        }
    })

    it("takes an empty limit or cursor as absent", async () => {
        await shops(...Array.from({ length: 21 }, (_, i) => ({ name: `Shop ${i}` })))
        const res = await request(app).get("/shops/browse?q=&cursor=&limit=")

        expect(res.status).toBe(200)
        expect(res.body.shops).toHaveLength(20)
    })

    it("searches each shop's own menu items, not every item", async () => {
        const items = await MenuModel.insertMany(Array.from({ length: 30 }, (_, i) => ({ name: `Item ${i}`, short_description: "x", price: 1, category: "food" })))
        await ShopModel.create({ name: "Cafe", shopMg: [new mongoose.Types.ObjectId()], menu: [items[0]._id, items[1]._id] })

        expect(names(await browse({ q: "item 1" }))).toEqual(["Cafe"])
        const plan = (await ShopModel.aggregate(browsePipeline("item 1", undefined, 20)).explain("executionStats")) as unknown as { stages: Record<string, unknown>[] }
        const lookup = plan.stages.find((stage) => "$lookup" in stage)
        expect(lookup).toMatchObject({ collectionScans: 0, totalDocsExamined: 2 })
    })

    it("leaves GET /shops/ as it was: every shop, with its menu", async () => {
        const { cookies } = await authFor("shopMg")
        const shopId = (await request(app).post("/shops").set("Cookie", cookies).send({ name: "Cafe" })).body._id
        await request(app).post(`/shops/${shopId}/menu`).set("Cookie", cookies).send({ name: "Latte", short_description: "x", price: 3, category: "drinks" })
        await shops({ name: "Second" })

        const all = await request(app).get("/shops/")
        expect(all.status).toBe(200)
        expect(all.body.map((s: { name: string }) => s.name)).toEqual(["Cafe", "Second"])
        expect(all.body[0].menu[0]).toMatchObject({ name: "Latte", price: 3 })
        expect(all.body[0].shopMg).toHaveLength(1)
    })
})
