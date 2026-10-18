import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import "./setup"
import app from "../server"
import { authFor, loginCookies } from "./helpers"
import ShopModel from "../services/shops/model"
import UserModel from "../services/users/model"
import mongoose from "mongoose"

// Who may do what on a shop (auth/middlewares.ts, shops/controllers), from the
// shop's members and the account's role. docs/auth.md#roles-and-ownership.

const createShop = async (cookies: string[], body: Record<string, unknown> = { name: "Cafe" }) =>
    request(app).post("/shops").set("Cookie", cookies).send(body)

// A shop saved before membership existed: shopMg alone.
const legacyShop = async (managerIds: unknown[]) =>
    (await ShopModel.collection.insertOne({ name: "Old", shopMg: managerIds, tables: [], menu: [], createdAt: new Date("2025-01-01T00:00:00Z"), updatedAt: new Date("2025-01-01T00:00:00Z") })).insertedId

// A member added as the staff routes will add them.
const addMember = (shopId: string, userId: mongoose.Types.ObjectId, role = "manager") =>
    ShopModel.updateOne({ _id: shopId }, { $push: { shopMg: userId, members: { userId, role, since: new Date() } } })

describe("creating a shop", () => {
    it("makes the caller its owner, in shopMg and members", async () => {
        const owner = await authFor("shopMg")
        const res = await createShop(owner.cookies)
        expect(res.status).toBe(200)
        expect(res.body.ownerId).toBe(String(owner.user._id))
        expect(res.body.shopMg).toEqual([String(owner.user._id)])
        expect(res.body.members).toEqual([expect.objectContaining({ userId: String(owner.user._id), role: "owner" })])
        expect(res.body.members[0].addedBy).toBeUndefined()
    })

    it("lets an administrator create a shop only for a named owner, who can't be an administrator", async () => {
        const admin = await authFor("admin")
        const other = await authFor("admin")
        const customer = await authFor("customer")

        expect((await createShop(admin.cookies)).status).toBe(400)
        expect((await createShop(admin.cookies, { name: "Cafe", ownerId: "0123456789abcdef01234567" })).status).toBe(404)
        const refused = await createShop(admin.cookies, { name: "Cafe", ownerId: String(other.user._id) })
        expect(refused.status).toBe(409)
        expect(refused.body.message).toBe("An administrator can't be a member of a shop")

        const res = await createShop(admin.cookies, { name: "Cafe", ownerId: String(customer.user._id) })
        expect(res.status).toBe(200)
        expect(res.body.ownerId).toBe(String(customer.user._id))
        expect(res.body.shopMg).toEqual([String(customer.user._id)])
        expect(res.body.members[0]).toMatchObject({ userId: String(customer.user._id), role: "owner", addedBy: String(admin.user._id) })

        // The new owner, a customer by account role, finds it under My Shops.
        const mine = await request(app).get("/shops/me").set("Cookie", customer.cookies)
        expect(mine.body.map((s: { _id: string }) => s._id)).toEqual([res.body._id])
    })

    it("refuses ownerId from a shop manager", async () => {
        const manager = await authFor("shopMg")
        const customer = await authFor("customer")
        const res = await createShop(manager.cookies, { name: "Cafe", ownerId: String(customer.user._id) })
        expect(res.status).toBe(403)
        expect(res.body.message).toBe("Only an administrator names an owner")
    })
})

describe("GET /shops/me", () => {
    it("answers [] to an account on no shop, and every shop to an administrator", async () => {
        const nobody = await authFor("customer")
        const empty = await request(app).get("/shops/me").set("Cookie", nobody.cookies)
        expect(empty.status).toBe(200)
        expect(empty.body).toEqual([])

        await createShop((await authFor("shopMg")).cookies)
        await createShop((await authFor("shopMg")).cookies)
        const admin = await authFor("admin")
        const all = await request(app).get("/shops/me").set("Cookie", admin.cookies)
        expect(all.status).toBe(200)
        expect(all.body).toHaveLength(await ShopModel.countDocuments())
    })

    it("carries the members, which the public views leave out", async () => {
        const owner = await authFor("shopMg")
        const shopId = (await createShop(owner.cookies)).body._id

        const mine = await request(app).get("/shops/me").set("Cookie", owner.cookies)
        expect(mine.body[0].members).toHaveLength(1)

        const one = await request(app).get(`/shops/${shopId}`)
        expect(one.body.members).toBeUndefined()
        expect(one.body.ownerId).toBe(String(owner.user._id))
        const all = await request(app).get("/shops")
        expect(all.body.find((s: { _id: string }) => s._id === shopId).members).toBeUndefined()
    })
})

describe("a shop from before membership", () => {
    it("is filled the first time a member opens it: first manager owner, the rest managers", async () => {
        const first = await authFor("shopMg")
        const second = await authFor("shopMg")
        const shopId = await legacyShop([first.user._id, second.user._id])

        // A public read leaves it as it is.
        const seen = await request(app).get(`/shops/${shopId}`)
        expect(seen.status).toBe(200)
        expect(seen.body.ownerId).toBeUndefined()
        expect(await ShopModel.exists({ _id: shopId, ownerId: { $exists: false } })).not.toBeNull()

        // The second manager edits it: let through as a manager, and the fill lands.
        const edited = await request(app).put(`/shops/${shopId}`).set("Cookie", second.cookies).send({ bio: "Hi" })
        expect(edited.status).toBe(200)
        const shop = await ShopModel.findById(shopId).lean()
        expect(String(shop!.ownerId)).toBe(String(first.user._id))
        expect(shop!.members.map((m) => ({ userId: String(m.userId), role: m.role, since: m.since }))).toEqual([
            { userId: String(first.user._id), role: "owner", since: new Date("2025-01-01T00:00:00Z") },
            { userId: String(second.user._id), role: "manager", since: new Date("2025-01-01T00:00:00Z") },
        ])
        // Only the owner deletes it.
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", second.cookies)).status).toBe(403)
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", first.cookies)).status).toBe(204)
    })

    it("is filled once when two members open it at the same time", async () => {
        const first = await authFor("shopMg")
        const second = await authFor("shopMg")
        const shopId = await legacyShop([first.user._id, second.user._id])

        const results = await Promise.all([
            request(app).put(`/shops/${shopId}`).set("Cookie", first.cookies).send({ bio: "A" }),
            request(app).put(`/shops/${shopId}`).set("Cookie", second.cookies).send({ bio: "B" }),
            request(app).get("/shops/me").set("Cookie", first.cookies),
        ])
        expect(results.map((r) => r.status)).toEqual([200, 200, 200])
        const shop = await ShopModel.findById(shopId).lean()
        expect(String(shop!.ownerId)).toBe(String(first.user._id))
        expect(shop!.members).toHaveLength(2)
        expect(shop!.members.filter((m) => m.role === "owner")).toHaveLength(1)
        // My Shops answers the filled shape even on the request that filled it.
        expect(results[2].body[0].ownerId).toBe(String(first.user._id))
        expect(results[2].body[0].members).toHaveLength(2)
    })
})

describe("a shop from before membership, opened by an administrator", () => {
    it("is filled by the visit, and can be deleted by the administrator", async () => {
        const first = await authFor("shopMg")
        const shopId = await legacyShop([first.user._id])
        const admin = await authFor("admin")

        const edited = await request(app).put(`/shops/${shopId}`).set("Cookie", admin.cookies).send({ bio: "By the admin" })
        expect(edited.status).toBe(200)
        expect(edited.body.ownerId).toBe(String(first.user._id))
        expect(edited.body.members).toEqual([expect.objectContaining({ userId: String(first.user._id), role: "owner" })])
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", admin.cookies)).status).toBe(204)
    })

    it("dates the members from now when the shop has no creation date", async () => {
        const first = await authFor("shopMg")
        const { insertedId } = await ShopModel.collection.insertOne({ name: "Older", shopMg: [first.user._id], tables: [], menu: [] })
        const before = Date.now()
        expect((await request(app).get("/shops/me").set("Cookie", first.cookies)).status).toBe(200)
        const shop = await ShopModel.findById(insertedId).lean()
        expect(shop!.members[0].since.getTime()).toBeGreaterThanOrEqual(before - 1000)
    })
})

describe("the shop guards", () => {
    it("let any member edit, only the owner delete, and refuse a stranger", async () => {
        const owner = await authFor("shopMg")
        const shopId = (await createShop(owner.cookies)).body._id
        const member = await authFor("customer")
        await addMember(shopId, member.user._id)
        const stranger = await authFor("shopMg")

        const asMember = await request(app).put(`/shops/${shopId}`).set("Cookie", member.cookies).send({ bio: "By a member" })
        expect(asMember.status).toBe(200)
        expect(asMember.body.bio).toBe("By a member")
        // The manager routes too, with a customer's account role.
        expect((await request(app).get(`/shops/${shopId}/tables/status`).set("Cookie", member.cookies)).status).toBe(200)
        expect((await request(app).post(`/shops/${shopId}/tables`).set("Cookie", member.cookies).send({ name: "T1" })).status).toBe(200)

        const asStranger = await request(app).put(`/shops/${shopId}`).set("Cookie", stranger.cookies).send({ bio: "No" })
        expect(asStranger.status).toBe(403)
        expect(asStranger.body.message).toBe("Shop Manager Only!")

        const memberDeletes = await request(app).delete(`/shops/${shopId}`).set("Cookie", member.cookies)
        expect(memberDeletes.status).toBe(403)
        expect(memberDeletes.body.message).toBe("Only the owner can do this")
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", stranger.cookies)).status).toBe(403)
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)
    })

    it("let an administrator through everywhere, and answer 404 for a shop that isn't there", async () => {
        const owner = await authFor("shopMg")
        const shopId = (await createShop(owner.cookies)).body._id
        const admin = await authFor("admin")

        const edited = await request(app).put(`/shops/${shopId}`).set("Cookie", admin.cookies).send({ bio: "By the admin" })
        expect(edited.status).toBe(200)
        expect(edited.body.bio).toBe("By the admin")
        // Running the shop too (the manager routes), without being a member.
        const table = await request(app).post(`/shops/${shopId}/tables`).set("Cookie", admin.cookies).send({ name: "T1" })
        expect(table.status).toBe(200)
        expect((await ShopModel.findById(shopId).lean())!.shopMg.map(String)).toEqual([String(owner.user._id)])
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", admin.cookies)).status).toBe(204)

        const gone = "0123456789abcdef01234567"
        expect((await request(app).put(`/shops/${gone}`).set("Cookie", admin.cookies).send({ bio: "x" })).status).toBe(404)
        expect((await request(app).delete(`/shops/${gone}`).set("Cookie", owner.cookies)).status).toBe(404)
    })
})

describe("deleting an account that is on a shop", () => {
    const remove = (cookies: string[], password: string) => request(app).delete("/users/me").set("Cookie", cookies).send({ currentPassword: password })

    it("is refused for the owner of a shop not yet filled, and lets its other manager go", async () => {
        const first = await authFor("shopMg")
        const second = await authFor("shopMg")
        const shopId = await legacyShop([first.user._id, second.user._id])

        const refused = await remove(first.cookies, first.password)
        expect(refused.status).toBe(409)
        expect(refused.body.message).toBe("Delete your shops first")

        expect((await remove(second.cookies, second.password)).status).toBe(204)
        const shop = await ShopModel.findById(shopId).lean()
        expect(shop!.shopMg.map(String)).toEqual([String(first.user._id)])
        expect(await UserModel.exists({ _id: second.user._id })).toBeNull()
    })

    it("removes a member from the shop's two lists, and refuses the owner and an administrator", async () => {
        const owner = await authFor("shopMg")
        const shopId = (await createShop(owner.cookies)).body._id
        const member = await authFor("customer")
        await addMember(shopId, member.user._id)

        expect((await remove(owner.cookies, owner.password)).status).toBe(409)

        expect((await remove(member.cookies, member.password)).status).toBe(204)
        const shop = await ShopModel.findById(shopId).lean()
        expect(shop!.shopMg.map(String)).toEqual([String(owner.user._id)])
        expect(shop!.members.map((m) => String(m.userId))).toEqual([String(owner.user._id)])

        const admin = await authFor("admin")
        const refused = await remove(admin.cookies, admin.password)
        expect(refused.status).toBe(409)
        expect(refused.body.message).toBe("An administrator's account is deleted by another administrator")
        // Still signed in, still an account.
        expect(await loginCookies(admin.email, admin.password)).not.toEqual([])
    })
})
