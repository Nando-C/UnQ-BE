import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"

const menuItem = {
    name: "Espresso",
    short_description: "Strong and short",
    price: 2.5,
    category: "drinks" as const,
}

describe("shops", () => {
    it("forbids a customer from creating a shop (403)", async () => {
        const { cookies } = await authFor("customer")

        const res = await request(app)
            .post("/shops")
            .set("Cookie", cookies)
            .send({ name: "Not Allowed" })

        expect(res.status).toBe(403)
    })

    it("lets a shopMg create a shop", async () => {
        const { cookies } = await authFor("shopMg")

        const res = await request(app)
            .post("/shops")
            .set("Cookie", cookies)
            .send({ name: "Corner Cafe", bio: "cozy" })

        expect(res.status).toBe(200)
        expect(res.body.name).toBe("Corner Cafe")
        expect(res.body.shopMg).toHaveLength(1)
    })

    it("strips non-whitelisted fields from the shop body", async () => {
        const { user, cookies } = await authFor("shopMg")

        const res = await request(app)
            .post("/shops")
            .set("Cookie", cookies)
            .send({ name: "Clean Cafe", shopMg: ["deadbeefdeadbeefdeadbeef"], menu: ["x"] })

        expect(res.status).toBe(200)
        // shopMg is set from the authenticated user, never from the body
        expect(res.body.shopMg.map(String)).toEqual([String(user._id)])
        expect(res.body.menu).toEqual([])
    })

    it("forbids a shopMg who doesn't manage the shop (isShopManager 403)", async () => {
        const owner = await authFor("shopMg")
        const shopRes = await request(app)
            .post("/shops")
            .set("Cookie", owner.cookies)
            .send({ name: "Owned Cafe" })
        const shopId = shopRes.body._id

        const intruder = await authFor("shopMg")
        const res = await request(app)
            .post(`/shops/${shopId}/menu`)
            .set("Cookie", intruder.cookies)
            .send(menuItem)

        expect(res.status).toBe(403)
    })

    it("renaming a table preserves its _id and Qr_Url", async () => {
        const owner = await authFor("shopMg")
        const shopRes = await request(app)
            .post("/shops")
            .set("Cookie", owner.cookies)
            .send({ name: "Table Cafe" })
        const shopId = shopRes.body._id

        const createRes = await request(app)
            .post(`/shops/${shopId}/tables`)
            .set("Cookie", owner.cookies)
            .send({ name: "Table 1" })
        const { _id: tableId, Qr_Url } = createRes.body

        const editRes = await request(app)
            .put(`/shops/${shopId}/tables/${tableId}`)
            .set("Cookie", owner.cookies)
            .send({ name: "Renamed" })

        expect(editRes.status).toBe(200)
        const renamedTable = editRes.body.find((t: { _id: string }) => String(t._id) === String(tableId))
        expect(renamedTable.name).toBe("Renamed")
        expect(String(renamedTable._id)).toBe(String(tableId))
        expect(renamedTable.Qr_Url).toBe(Qr_Url)
        expect(renamedTable.Qr_Url).toContain(String(tableId))
    })

    describe("menu CRUD through /shops/:shopId/menu", () => {
        it("won't read, edit or delete another shop's item through your own shop", async () => {
            const victim = await authFor("shopMg")
            const victimShop = (await request(app).post("/shops").set("Cookie", victim.cookies).send({ name: "Victim Cafe" })).body._id
            const itemId = (await request(app).post(`/shops/${victimShop}/menu`).set("Cookie", victim.cookies).send(menuItem)).body._id

            const intruder = await authFor("shopMg")
            const ownShop = (await request(app).post("/shops").set("Cookie", intruder.cookies).send({ name: "Own Cafe" })).body._id
            const via = `/shops/${ownShop}/menu/${itemId}`

            expect((await request(app).get(via).set("Cookie", intruder.cookies)).status).toBe(404)
            expect((await request(app).put(via).set("Cookie", intruder.cookies).send({ price: 0.01 })).status).toBe(404)
            expect((await request(app).delete(via).set("Cookie", intruder.cookies)).status).toBe(404)

            const list = await request(app).get(`/shops/${victimShop}/menu`).set("Cookie", victim.cookies)
            expect(list.body).toHaveLength(1)
            expect(list.body[0].price).toBe(menuItem.price)
        })

        it("supports create, list, read, update, and delete", async () => {
            const owner = await authFor("shopMg")
            const shopRes = await request(app)
                .post("/shops")
                .set("Cookie", owner.cookies)
                .send({ name: "Menu Cafe" })
            const shopId = shopRes.body._id

            // create
            const createRes = await request(app)
                .post(`/shops/${shopId}/menu`)
                .set("Cookie", owner.cookies)
                .send(menuItem)
            expect(createRes.status).toBe(200)
            expect(createRes.body.name).toBe(menuItem.name)
            const itemId = createRes.body._id

            // list
            const listRes = await request(app)
                .get(`/shops/${shopId}/menu`)
                .set("Cookie", owner.cookies)
            expect(listRes.status).toBe(200)
            expect(listRes.body).toHaveLength(1)

            // read
            const readRes = await request(app)
                .get(`/shops/${shopId}/menu/${itemId}`)
                .set("Cookie", owner.cookies)
            expect(readRes.status).toBe(200)
            expect(readRes.body._id).toBe(itemId)

            // update
            const editRes = await request(app)
                .put(`/shops/${shopId}/menu/${itemId}`)
                .set("Cookie", owner.cookies)
                .send({ price: 3.75 })
            expect(editRes.status).toBe(200)
            expect(editRes.body.price).toBe(3.75)

            // delete
            const delRes = await request(app)
                .delete(`/shops/${shopId}/menu/${itemId}`)
                .set("Cookie", owner.cookies)
            expect(delRes.status).toBe(204)

            // gone from the list
            const afterList = await request(app)
                .get(`/shops/${shopId}/menu`)
                .set("Cookie", owner.cookies)
            expect(afterList.body).toHaveLength(0)
        })

        it("rejects an invalid menu item with 400", async () => {
            const owner = await authFor("shopMg")
            const shopRes = await request(app)
                .post("/shops")
                .set("Cookie", owner.cookies)
                .send({ name: "Validation Cafe" })
            const shopId = shopRes.body._id

            const res = await request(app)
                .post(`/shops/${shopId}/menu`)
                .set("Cookie", owner.cookies)
                .send({ name: "No price", short_description: "x", category: "food" })

            expect(res.status).toBe(400)
        })
    })
})
