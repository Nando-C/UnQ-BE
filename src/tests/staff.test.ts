import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import "./setup"
import app from "../server"
import { authFor, loginCookies } from "./helpers"
import ShopModel from "../services/shops/model"
import UserModel from "../services/users/model"

// A shop's staff routes (shops/controllers/staffControllers.ts): who adds,
// removes and hands over, and create-or-attach by email. docs/auth.md.

const shopFor = async (owner: Awaited<ReturnType<typeof authFor>>) =>
    (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id as string
const add = (shopId: string, cookies: string[], body: Record<string, unknown>) =>
    request(app).post(`/shops/${shopId}/staff`).set("Cookie", cookies).send({ role: "manager", ...body })
const staff = (shopId: string, cookies: string[]) => request(app).get(`/shops/${shopId}/staff`).set("Cookie", cookies)
const remove = (shopId: string, userId: unknown, cookies: string[]) => request(app).delete(`/shops/${shopId}/staff/${userId}`).set("Cookie", cookies)
const handOver = (shopId: string, userId: unknown, cookies: string[]) => request(app).put(`/shops/${shopId}/owner`).set("Cookie", cookies).send({ userId: String(userId) })
const newcomer = { email: "alex@example.com", name: "Alex", surname: "New", password: "firstpass1" }
const freshEmail = () => `new-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`

describe("adding staff", () => {
    it("creates an account for an address without one, which signs in and finds the shop", async () => {
        const owner = await authFor("shopMg")
        const shopId = await shopFor(owner)
        const email = freshEmail()

        const res = await add(shopId, owner.cookies, { ...newcomer, email })
        expect(res.status).toBe(201)
        expect(res.body.created).toBe(true)
        expect(res.body.member).toMatchObject({ name: "Alex", surname: "New", email, role: "manager", addedBy: String(owner.user._id) })

        const stored = await UserModel.findOne({ email })
        expect(stored).toMatchObject({ role: "customer", createdBy: owner.user._id })
        expect(stored!.password).not.toBe(newcomer.password) // hashed
        const cookies = await loginCookies(email, newcomer.password)
        const mine = await request(app).get("/shops/me").set("Cookie", cookies)
        expect(mine.body.map((s: { _id: string }) => s._id)).toEqual([shopId])

        const shop = await ShopModel.findById(shopId).lean()
        expect(shop!.shopMg.map(String)).toEqual([String(owner.user._id), String(stored!._id)])
        expect(shop!.members.map((m) => m.role)).toEqual(["owner", "manager"])
    })

    it("attaches an existing account as it is, and needs no name or password for it", async () => {
        const owner = await authFor("shopMg")
        const shopId = await shopFor(owner)
        const diner = await authFor("customer")

        const res = await add(shopId, owner.cookies, { email: diner.email.toUpperCase() })
        expect(res.status).toBe(200)
        expect(res.body.created).toBe(false)
        expect(res.body.member.userId).toBe(String(diner.user._id))
        const stored = await UserModel.findById(diner.user._id)
        expect(stored!.role).toBe("customer")
        expect(stored!.createdBy).toBeUndefined()
        expect(await loginCookies(diner.email, diner.password)).not.toEqual([])

        // An account that can open shops of its own keeps that role too.
        const other = await authFor("shopMg")
        expect((await add(shopId, owner.cookies, { email: other.email })).status).toBe(200)
        expect((await UserModel.findById(other.user._id))!.role).toBe("shopMg")
    })

    it("refuses a new account without its fields, the caller's own address, a member twice and an administrator", async () => {
        const owner = await authFor("shopMg")
        const shopId = await shopFor(owner)

        const bare = await add(shopId, owner.cookies, { email: freshEmail() })
        expect(bare.status).toBe(400)
        expect(bare.body.details.map((d: { path: string }) => d.path).sort()).toEqual(["name", "password", "surname"])
        expect((await add(shopId, owner.cookies, { ...newcomer, email: freshEmail(), password: "short" })).status).toBe(400)

        const own = await add(shopId, owner.cookies, { email: owner.email })
        expect([own.status, own.body.message]).toEqual([400, "That is your own address"])

        const diner = await authFor("customer")
        expect((await add(shopId, owner.cookies, { email: diner.email })).status).toBe(200)
        const twice = await add(shopId, owner.cookies, { email: diner.email })
        expect([twice.status, twice.body.message]).toEqual([409, "Already a member"])

        const admin = await authFor("admin")
        const asMember = await add(shopId, owner.cookies, { email: admin.email })
        expect([asMember.status, asMember.body.message]).toEqual([409, "An administrator can't be a member of a shop"])
        expect((await ShopModel.findById(shopId).lean())!.members).toHaveLength(2)
    })

    it("is the owner's: a manager can't add a manager, a stranger can't add anyone, an administrator can", async () => {
        const owner = await authFor("shopMg")
        const shopId = await shopFor(owner)
        const manager = await authFor("customer")
        expect((await add(shopId, owner.cookies, { email: manager.email })).status).toBe(200)

        const byManager = await add(shopId, manager.cookies, { ...newcomer, email: freshEmail() })
        expect([byManager.status, byManager.body.message]).toEqual([403, "Only the owner adds managers"])
        expect((await add(shopId, (await authFor("shopMg")).cookies, { ...newcomer, email: freshEmail() })).status).toBe(403)

        const admin = await authFor("admin")
        const byAdmin = await add(shopId, admin.cookies, { ...newcomer, email: freshEmail() })
        expect(byAdmin.status).toBe(201)
        expect(byAdmin.body.member.addedBy).toBe(String(admin.user._id))
    })

    it("lands once when the same person is added twice at the same time", async () => {
        const owner = await authFor("shopMg")
        const shopId = await shopFor(owner)
        const email = freshEmail()

        const results = await Promise.all([1, 2, 3].map(() => add(shopId, owner.cookies, { ...newcomer, email })))
        const statuses = results.map((r) => r.status)
        expect(statuses.filter((s) => s < 300)).toHaveLength(1) // created, or attached if the creator lost the push
        expect(statuses.filter((s) => s === 409)).toHaveLength(2)
        expect(await UserModel.countDocuments({ email })).toBe(1)
        const shop = await ShopModel.findById(shopId).lean()
        expect(shop!.members).toHaveLength(2)
        expect(shop!.shopMg).toHaveLength(2)
    })
})

describe("the staff list", () => {
    it("joins the members to their accounts, the owner first, for any member and an administrator but nobody else", async () => {
        const owner = await authFor("shopMg")
        const shopId = await shopFor(owner)
        const manager = await authFor("customer")
        await add(shopId, owner.cookies, { email: manager.email })

        const res = await staff(shopId, manager.cookies)
        expect(res.status).toBe(200)
        expect(res.body.members.map((m: { role: string; email: string }) => [m.role, m.email])).toEqual([["owner", owner.email], ["manager", manager.email]])
        expect(res.body.members[0]).toMatchObject({ userId: String(owner.user._id), name: "Test" })
        expect(res.body.members[0].since).toBeDefined()
        expect(res.body.members[1].addedBy).toBe(String(owner.user._id))

        expect((await staff(shopId, (await authFor("admin")).cookies)).status).toBe(200)
        expect((await staff(shopId, (await authFor("customer")).cookies)).status).toBe(403)
        expect((await request(app).get(`/shops/${shopId}/staff`)).status).toBe(401)
        // The public shop still shows no members.
        expect((await request(app).get(`/shops/${shopId}`)).body.members).toBeUndefined()
    })
})

describe("removing staff", () => {
    it("lets the owner remove a manager, a manager leave, and nobody remove the owner", async () => {
        const owner = await authFor("shopMg")
        const shopId = await shopFor(owner)
        const first = await authFor("customer")
        const second = await authFor("customer")
        await add(shopId, owner.cookies, { email: first.email })
        await add(shopId, owner.cookies, { email: second.email })

        const byManager = await remove(shopId, second.user._id, first.cookies)
        expect([byManager.status, byManager.body.message]).toEqual([403, "Only the owner removes a manager"])
        const theOwner = await remove(shopId, owner.user._id, first.cookies)
        expect([theOwner.status, theOwner.body.message]).toEqual([403, "The owner can't be removed"])
        expect((await remove(shopId, owner.user._id, (await authFor("admin")).cookies)).status).toBe(403)
        expect((await remove(shopId, owner.user._id, owner.cookies)).status).toBe(403)

        expect((await remove(shopId, first.user._id, first.cookies)).status).toBe(204) // leaving
        expect((await remove(shopId, second.user._id, owner.cookies)).status).toBe(204)
        const shop = await ShopModel.findById(shopId).lean()
        expect(shop!.shopMg.map(String)).toEqual([String(owner.user._id)])
        expect(shop!.members).toHaveLength(1)
        // The accounts stay.
        expect(await UserModel.countDocuments({ _id: { $in: [first.user._id, second.user._id] } })).toBe(2)
        expect((await request(app).get("/shops/me").set("Cookie", first.cookies)).body).toEqual([])

        expect((await remove(shopId, second.user._id, owner.cookies)).status).toBe(404)
        expect((await remove(shopId, "not-an-id", owner.cookies)).status).toBe(404)
        expect((await remove(shopId, first.user._id, (await authFor("shopMg")).cookies)).status).toBe(403)
    })
})

describe("handing the shop over", () => {
    it("makes a member the owner and the owner a manager, for the owner or an administrator", async () => {
        const owner = await authFor("shopMg")
        const shopId = await shopFor(owner)
        const manager = await authFor("customer")
        await add(shopId, owner.cookies, { email: manager.email })

        expect((await handOver(shopId, owner.user._id, manager.cookies)).status).toBe(403)
        const stranger = await handOver(shopId, (await authFor("customer")).user._id, owner.cookies)
        expect([stranger.status, stranger.body.message]).toEqual([404, "Not a member of this shop"])
        const already = await handOver(shopId, owner.user._id, owner.cookies)
        expect([already.status, already.body.message]).toEqual([409, "Already the owner"])

        // A hand-over to someone just removed finds the staff changed.
        const gone = await authFor("customer")
        await add(shopId, owner.cookies, { email: gone.email })
        await remove(shopId, gone.user._id, owner.cookies)
        expect((await handOver(shopId, gone.user._id, owner.cookies)).status).toBe(404)

        const res = await handOver(shopId, manager.user._id, owner.cookies)
        expect(res.status).toBe(200)
        expect(res.body.members.map((m: { role: string; userId: string }) => [m.role, m.userId])).toEqual([["owner", String(manager.user._id)], ["manager", String(owner.user._id)]])
        const shop = await ShopModel.findById(shopId).lean()
        expect(String(shop!.ownerId)).toBe(String(manager.user._id))
        // The new owner deletes; the old one no longer can, but can leave.
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(403)
        expect((await remove(shopId, owner.user._id, owner.cookies)).status).toBe(204)

        const admin = await authFor("admin")
        const back = await authFor("customer")
        await add(shopId, manager.cookies, { email: back.email }).then((r) => expect(r.status).toBe(200))
        expect((await handOver(shopId, back.user._id, admin.cookies)).status).toBe(200)
        expect(String((await ShopModel.findById(shopId).lean())!.ownerId)).toBe(String(back.user._id))
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", back.cookies)).status).toBe(204)
    })
})
