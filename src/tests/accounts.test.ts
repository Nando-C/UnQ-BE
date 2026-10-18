import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import "./setup"
import app from "../server"
import { authFor, loginCookies } from "./helpers"
import ShopModel from "../services/shops/model"
import UserModel from "../services/users/model"

// An administrator's account routes (users/controllers.ts). docs/auth.md.

const list = (cookies: string[], query = "") => request(app).get(`/users${query}`).set("Cookie", cookies)
const create = (cookies: string[], body: Record<string, unknown>) => request(app).post("/users").set("Cookie", cookies).send(body)
const setRole = (cookies: string[], userId: unknown, role: string) => request(app).put(`/users/${userId}/role`).set("Cookie", cookies).send({ role })
const remove = (cookies: string[], userId: unknown) => request(app).delete(`/users/${userId}`).set("Cookie", cookies)
const account = { name: "Pat", surname: "Made", password: "firstpass1" }
const freshEmail = () => `made-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`

describe("the account routes", () => {
    it("are the administrator's alone", async () => {
        for (const role of ["customer", "shopMg"] as const) {
            const { cookies, user } = await authFor(role)
            expect((await list(cookies)).status).toBe(403)
            expect((await create(cookies, { ...account, email: freshEmail() })).status).toBe(403)
            expect((await setRole(cookies, user._id, "admin")).status).toBe(403)
            expect((await remove(cookies, user._id)).status).toBe(403)
            expect((await UserModel.findById(user._id))!.role).toBe(role)
        }
        expect((await request(app).get("/users")).status).toBe(401)
    })

    it("list accounts newest first, searched and paged, with the shops each is on", async () => {
        const admin = await authFor("admin")
        const owner = await authFor("shopMg")
        const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Searchable Cafe" })).body._id
        const manager = await authFor("customer")
        await request(app).post(`/shops/${shopId}/staff`).set("Cookie", owner.cookies).send({ email: manager.email, role: "manager" })

        const res = await list(admin.cookies, "?limit=2")
        expect(res.status).toBe(200)
        expect(res.body.users).toHaveLength(2)
        expect(res.body).toMatchObject({ page: 1, limit: 2 })
        expect(res.body.total).toBe(await UserModel.countDocuments())
        expect(res.body.users[0]._id).toBe(String(manager.user._id)) // newest
        expect(res.body.users[0].shops).toEqual([{ _id: shopId, name: "Searchable Cafe", role: "manager" }])
        expect(res.body.users[0].password).toBeUndefined()
        expect(res.body.users[0].sessions).toBeUndefined()

        // Searched literally: the dot in the address is no wildcard.
        expect((await list(admin.cookies, `?q=${encodeURIComponent("owner.email.that.matches.nothing")}`)).body.users).toEqual([])
        const byEmail = await list(admin.cookies, `?q=${encodeURIComponent(owner.email.toUpperCase())}`)
        expect(byEmail.body.users.map((u: { _id: string }) => u._id)).toEqual([String(owner.user._id)])
        expect(byEmail.body.users[0].shops).toEqual([{ _id: shopId, name: "Searchable Cafe", role: "owner" }])
        const admins = await list(admin.cookies, "?role=admin")
        expect(admins.body.users.every((u: { role: string }) => u.role === "admin")).toBe(true)
        expect(admins.body.users.map((u: { _id: string }) => u._id)).toContain(String(admin.user._id))
        expect((await list(admin.cookies, "?page=0")).status).toBe(400)
        expect((await list(admin.cookies, "?limit=51")).status).toBe(400)
        const second = await list(admin.cookies, "?limit=1&page=2")
        expect(second.body.users).toHaveLength(1)
        expect(second.body.users[0]._id).toBe(res.body.users[1]._id)
    })

    it("create an account with any role, which signs in, and refuse a taken address", async () => {
        const admin = await authFor("admin")
        const email = freshEmail()

        const asCustomer = await create(admin.cookies, { ...account, email, createdBy: "0123456789abcdef01234567" })
        expect(asCustomer.status).toBe(201) // createdBy from the body is dropped: the schema's fields only
        expect(asCustomer.body).toMatchObject({ email, role: "customer", createdBy: String(admin.user._id), hasPassword: true })
        expect(await loginCookies(email, account.password)).not.toEqual([])

        const asManager = await create(admin.cookies, { ...account, email: freshEmail(), role: "shopMg" })
        expect(asManager.body.role).toBe("shopMg")
        const asAdmin = await create(admin.cookies, { ...account, email: freshEmail(), role: "admin" })
        expect(asAdmin.body.role).toBe("admin")

        const taken = await create(admin.cookies, { ...account, email })
        expect([taken.status, taken.body.message]).toEqual([409, "Email already registered"])
        expect((await create(admin.cookies, { ...account, email: freshEmail(), password: "short" })).status).toBe(400)
        expect((await create(admin.cookies, { ...account, email: freshEmail(), role: "owner" })).status).toBe(400)
    })

    it("set a role: not their own, not admin for an account on a shop", async () => {
        const admin = await authFor("admin")
        const diner = await authFor("customer")
        const owner = await authFor("shopMg")
        await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })

        const own = await setRole(admin.cookies, admin.user._id, "customer")
        expect([own.status, own.body.message]).toEqual([400, "You can't change your own role"])
        const onShop = await setRole(admin.cookies, owner.user._id, "admin")
        expect([onShop.status, onShop.body.message]).toEqual([409, "Hand over or leave their shops first"])

        const promoted = await setRole(admin.cookies, diner.user._id, "shopMg")
        expect(promoted.status).toBe(200)
        expect(promoted.body.role).toBe("shopMg")
        expect((await setRole(admin.cookies, diner.user._id, "admin")).body.role).toBe("admin")
        // The new administrator can demote the first; the first, a customer now, can do nothing here.
        const dinerCookies = await loginCookies(diner.email, diner.password)
        expect((await setRole(dinerCookies, admin.user._id, "customer")).status).toBe(200)
        expect((await setRole(admin.cookies, diner.user._id, "customer")).status).toBe(403)
        expect((await setRole(dinerCookies, diner.user._id, "customer")).status).toBe(400) // the last one can't demote themselves

        expect((await setRole(dinerCookies, "0123456789abcdef01234567", "customer")).status).toBe(404)
        expect((await setRole(dinerCookies, "nope", "customer")).status).toBe(404)
        expect((await setRole(dinerCookies, owner.user._id, "owner")).status).toBe(400)
    })

    it("delete an account: the shops it worked at lose it; not their own, not an owner's", async () => {
        const admin = await authFor("admin")
        const owner = await authFor("shopMg")
        const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
        const manager = await authFor("customer")
        await request(app).post(`/shops/${shopId}/staff`).set("Cookie", owner.cookies).send({ email: manager.email, role: "manager" })

        const own = await remove(admin.cookies, admin.user._id)
        expect([own.status, own.body.message]).toEqual([400, "Another administrator deletes your account"])
        const theOwner = await remove(admin.cookies, owner.user._id)
        expect([theOwner.status, theOwner.body.message]).toEqual([409, "Transfer or delete their shops first"])

        expect((await remove(admin.cookies, manager.user._id)).status).toBe(204)
        expect(await UserModel.exists({ _id: manager.user._id })).toBeNull()
        const shop = await ShopModel.findById(shopId).lean()
        expect(shop!.shopMg.map(String)).toEqual([String(owner.user._id)])
        expect(shop!.members).toHaveLength(1)
        expect((await request(app).get("/shops/me").set("Cookie", manager.cookies)).status).toBe(404) // the session went with the account

        const other = await authFor("admin")
        expect((await remove(admin.cookies, other.user._id)).status).toBe(204) // another administrator can go
        expect((await remove(admin.cookies, "0123456789abcdef01234567")).status).toBe(404)
        expect((await remove(admin.cookies, "nope")).status).toBe(404)
    })
})
