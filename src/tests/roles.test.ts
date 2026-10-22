import { jest, describe, it, expect, beforeEach } from "@jest/globals"

// PayPal mocked at the module boundary, before the app is imported (the till's refund).
jest.mock("../lib/paypal", () => ({
    getOrder: jest.fn(),
    createOrder: jest.fn(),
    captureOrder: jest.fn(),
    refundCapture: jest.fn(),
    findRefund: jest.fn(),
    PayPalRefundRefused: jest.requireActual<typeof import("../lib/paypal")>("../lib/paypal").PayPalRefundRefused,
    PayPalCaptureRefused: jest.requireActual<typeof import("../lib/paypal")>("../lib/paypal").PayPalCaptureRefused,
}))

import request, { Response as HttpResponse } from "supertest"
import { NextFunction, Response } from "express"
import { TController } from "../typings/controllers"
import "./setup"
import app, { routeAbilities, routeList } from "../server"
import { authFor } from "./helpers"
import { ABILITIES, Ability, MEMBER_ROLES, MemberRole, can, holdersOf } from "../services/shops/roles"
import { ROLE_REFUSED, allows, allowsMenuChange, isShopOwner } from "../services/auth/middlewares"
import CartModel from "../services/carts/model"
import ShopModel from "../services/shops/model"
import { refundCapture, findRefund } from "../lib/paypal"

// What each member role may do on a shop (shops/roles.ts), the guards that
// decide it (auth/middlewares.ts allows) and the routes that carry them.
// docs/auth.md#roles-and-ownership.

const mockedRefund = jest.mocked(refundCapture)
beforeEach(() => {
    mockedRefund.mockReset()
    mockedRefund.mockResolvedValue("REF-1")
    jest.mocked(findRefund).mockReset()
    jest.mocked(findRefund).mockResolvedValue(null)
})

// Runs a guard with the role isShopManager would have set, and tells what it did.
const decide = async (guard: TController, shopRole: string | undefined, body: unknown = {}) => {
    let outcome: "passed" | number = "passed"
    await guard({ shopRole, body } as unknown as Parameters<TController>[0], {} as Response, ((e?: unknown) => { if (e) outcome = (e as { status: number }).status }) as NextFunction)
    return outcome
}

describe("the ability table", () => {
    it("gives each role what docs/auth.md says, and an administrator everything", () => {
        expect(MEMBER_ROLES).toEqual(["owner", "manager", "till", "floor", "kitchen"])
        const held = (role: MemberRole) => (Object.keys(ABILITIES) as Ability[]).filter((a) => can(role, a))
        expect(held("owner")).toEqual(Object.keys(ABILITIES))
        expect(held("manager")).toEqual(Object.keys(ABILITIES).filter((a) => a !== "shop.own"))
        expect(held("till")).toEqual(["menu.availability", "tables.read", "carts.fix", "payments.manage", "staff.read"])
        expect(held("floor")).toEqual(["menu.availability", "tables.read", "carts.fix", "staff.read"])
        expect(held("kitchen")).toEqual(["menu.availability", "tables.read", "staff.read"])
        for (const ability of Object.keys(ABILITIES) as Ability[]) {
            expect(can("admin", ability)).toBe(true)
            expect(can(undefined, ability)).toBe(false)
        }
        expect(holdersOf(["payments.manage"])).toEqual(["owner", "manager", "till"])
        expect(holdersOf(["menu.edit", "menu.availability"])).toEqual([...MEMBER_ROLES])
    })

    it("is what allows() answers, 403 with the one role message otherwise", async () => {
        for (const ability of Object.keys(ABILITIES) as Ability[]) {
            const guard = allows(ability)
            expect(guard.abilities).toEqual([ability])
            for (const role of MEMBER_ROLES) expect([ability, role, await decide(guard, role)]).toEqual([ability, role, can(role, ability) ? "passed" : 403])
            expect(await decide(guard, "admin")).toBe("passed")
            expect(await decide(guard, undefined)).toBe(403)
        }
        expect(isShopOwner.abilities).toEqual(["shop.own"])
    })

    it("reads the menu edit's body: the switch alone is every member's, anything else an edit", async () => {
        expect(allowsMenuChange.abilities).toEqual(["menu.edit", "menu.availability"])
        expect(await decide(allowsMenuChange, "kitchen", { available: false })).toBe("passed")
        expect(await decide(allowsMenuChange, "kitchen", { available: false, name: "Soup" })).toBe(403)
        expect(await decide(allowsMenuChange, "kitchen", {})).toBe(403)
        expect(await decide(allowsMenuChange, "kitchen", undefined)).toBe(403)
        expect(await decide(allowsMenuChange, "manager", {})).toBe("passed")
        expect(await decide(allowsMenuChange, "admin", { price: 4 })).toBe("passed")
    })
})

describe("the routes' ability guards", () => {
    // Every shop route behind isShopManager carries one guard (the two owner
    // routes theirs); the three staff writes decide in their controller.
    const expected: Record<string, Ability[]> = {
        "PUT /shops/:shopId": ["shop.edit"],
        "PUT /shops/:shopId/cover": ["shop.edit"],
        "DELETE /shops/:shopId": ["shop.own"],
        "PUT /shops/:shopId/owner": ["shop.own"],
        "GET /shops/:shopId/staff": ["staff.read"],
        "GET /shops/:shopId/sales": ["sales.read"],
        "GET /shops/:shopId/sales/export": ["sales.read"],
        "GET /shops/:shopId/tables/status": ["tables.read"],
        "GET /shops/:shopId/tables/:tableId/carts": ["tables.read"],
        "POST /shops/:shopId/tables/:tableId/carts/:cartId/releaseSelection": ["carts.fix"],
        "POST /shops/:shopId/tables/:tableId/carts/:cartId/removeItem": ["carts.fix"],
        "POST /shops/:shopId/tables/:tableId/carts/:cartId/close": ["carts.fix"],
        "POST /shops/:shopId/tables/:tableId/carts/:cartId/mergeInto": ["carts.fix"],
        "POST /shops/:shopId/carts/:cartId/refunds": ["payments.manage"],
        "POST /shops/:shopId/carts/:cartId/refunds/:refundId/retry": ["payments.manage"],
        "POST /shops/:shopId/carts/:cartId/payments/:paymentId/check": ["payments.manage"],
        "POST /shops/:shopId/paybacks/:paybackId/done": ["payments.manage"],
        "POST /shops/:shopId/tables": ["tables.edit"],
        "PUT /shops/:shopId/tables/:tableId": ["tables.edit"],
        "DELETE /shops/:shopId/tables/:tableId": ["tables.edit"],
        "POST /shops/:shopId/menu": ["menu.edit"],
        "PUT /shops/:shopId/menu/:itemId": ["menu.edit", "menu.availability"],
        "PUT /shops/:shopId/menu/:itemId/img": ["menu.edit"],
        "DELETE /shops/:shopId/menu/:itemId": ["menu.edit"],
    }

    it("are on exactly the 24 guarded shop routes, with the abilities the matrix gives them", () => {
        const guarded = Object.fromEntries([...routeAbilities()].filter(([, abilities]) => abilities))
        expect(guarded).toEqual(expected)
        // The staff writes and every other route decide otherwise.
        for (const route of ["POST /shops/:shopId/staff", "PUT /shops/:shopId/staff/:userId", "DELETE /shops/:shopId/staff/:userId", "GET /shops/:shopId/tables", "GET /shops/:shopId/menu"]) {
            expect(routeList().map((r) => `${r.method} ${r.path}`)).toContain(route)
            expect(routeAbilities().get(route)).toBeUndefined()
        }
    })
})

// A shop with a table, a £3 Latte, and one member of each role; a diner.
const scaffold = async () => {
    const owner = await authFor("shopMg")
    const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id as string
    const tableId = (await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name: "T1" })).body._id as string
    const latte = (await request(app).post(`/shops/${shopId}/menu`).set("Cookie", owner.cookies)
        .send({ name: "Latte", short_description: "x", price: 3, category: "drinks" })).body._id as string
    const member = async (role: MemberRole) => {
        const account = await authFor("customer")
        const res = await request(app).post(`/shops/${shopId}/staff`).set("Cookie", owner.cookies).send({ email: account.email, role })
        expect([role, res.status]).toEqual([role, 200])
        return account
    }
    const manager = await member("manager")
    const till = await member("till")
    const floor = await member("floor")
    const kitchen = await member("kitchen")
    const ada = await authFor("customer")
    const order = async (qty: number) =>
        (await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", ada.cookies).send({ menuId: latte, qty })).body._id as string
    // `qty` lattes paid by PayPal, so they can be refunded.
    const pay = async (cartId: string, qty: number) => {
        const paidAt = new Date()
        await CartModel.updateOne({ _id: cartId }, {
            $set: { "items.0.qtyPayed": qty },
            $push: {
                split: { userId: ada.user._id, menuId: latte, qty, splitStatus: "closed", unitPrice: 3, paidAt },
                payments: { provider: "paypal", providerCheckoutId: "ORDER-1", providerPaymentId: "CAP-1", currency: "GBP", userId: ada.user._id, paidAt, amount: 3 * qty, lines: [{ menuId: latte, name: "Latte", qty, unitPrice: 3 }] },
            },
        })
        return String((await CartModel.findById(cartId))!.payments[0]._id)
    }
    type Who = { cookies: string[]; user: { _id: unknown } }
    const as = (who: Who) => ({
        get: (path: string) => request(app).get(`/shops/${shopId}${path}`).set("Cookie", who.cookies),
        post: (path: string, body: object = {}) => request(app).post(`/shops/${shopId}${path}`).set("Cookie", who.cookies).send(body),
        put: (path: string, body: object = {}) => request(app).put(`/shops/${shopId}${path}`).set("Cookie", who.cookies).send(body),
        delete: (path: string) => request(app).delete(`/shops/${shopId}${path}`).set("Cookie", who.cookies),
    })
    const roles = async () => Object.fromEntries((await ShopModel.findById(shopId).lean())!.members.map((m) => [String(m.userId), m.role]))
    return { owner, shopId, tableId, latte, manager, till, floor, kitchen, ada, order, pay, as, roles }
}

const refused = (res: HttpResponse) => [res.status, res.body.message]

describe("each role on the shop", () => {
    it("kitchen: flips a dish's availability, reads the tables, and nothing else", async () => {
        const { kitchen, latte, tableId, order, as } = await scaffold()
        const k = as(kitchen)
        expect((await k.put(`/menu/${latte}`, { available: false })).status).toBe(200)
        expect(refused(await k.put(`/menu/${latte}`, { available: true, name: "Flat white" }))).toEqual([403, ROLE_REFUSED])
        expect(refused(await k.put(`/menu/${latte}`, {}))).toEqual([403, ROLE_REFUSED])
        // Validation and the item lookup come before the role on this route.
        expect((await k.put(`/menu/${latte}`, { available: "yes" })).status).toBe(400)
        expect((await k.put(`/menu/${tableId}`, { available: true })).status).toBe(404)
        expect(refused(await k.delete(`/menu/${latte}`))).toEqual([403, ROLE_REFUSED])
        expect(refused(await k.post("/menu", { name: "Soup", short_description: "x", price: 4, category: "food" }))).toEqual([403, ROLE_REFUSED])
        expect(refused(await k.post("/tables", { name: "T2" }))).toEqual([403, ROLE_REFUSED])
        expect(refused(await k.put("", { name: "Bistro" }))).toEqual([403, ROLE_REFUSED])
        expect(refused(await k.get("/sales?from=2026-01-01&to=2026-01-02"))).toEqual([403, ROLE_REFUSED])
        const cartId = await order(2)
        expect(refused(await k.post(`/tables/${tableId}/carts/${cartId}/close`))).toEqual([403, ROLE_REFUSED])
        expect((await k.get("/tables/status")).status).toBe(200)
        expect((await k.get(`/tables/${tableId}/carts`)).status).toBe(200)
        expect((await k.get("/staff")).body.members).toHaveLength(5)
    })

    it("floor: fixes a cart, no money", async () => {
        const { floor, tableId, order, pay, as } = await scaffold()
        const f = as(floor)
        const cartId = await order(2)
        const paymentId = await pay(cartId, 1)
        expect(refused(await f.post(`/carts/${cartId}/refunds`, { paymentId, lines: [{ menuId: (await CartModel.findById(cartId))!.items[0].menuId, qty: 1 }], }))).toEqual([403, ROLE_REFUSED])
        expect(refused(await f.post(`/carts/${cartId}/payments/${paymentId}/check`))).toEqual([403, ROLE_REFUSED])
        expect((await f.post(`/tables/${tableId}/carts/${cartId}/close`)).status).toBe(200)
        expect(refused(await f.put("", { name: "Bistro" }))).toEqual([403, ROLE_REFUSED])
    })

    it("till: refunds, no report and no tables' setup", async () => {
        const { till, latte, tableId, order, pay, as } = await scaffold()
        const t = as(till)
        const cartId = await order(2)
        const paymentId = await pay(cartId, 2)
        const res = await t.post(`/carts/${cartId}/refunds`, { paymentId, lines: [{ menuId: latte, qty: 1 }], })
        expect(res.status).toBe(200)
        expect(mockedRefund).toHaveBeenCalledTimes(1)
        expect(refused(await t.get("/sales?from=2026-01-01&to=2026-01-02"))).toEqual([403, ROLE_REFUSED])
        expect(refused(await t.put(`/tables/${tableId}`, { name: "T9" }))).toEqual([403, ROLE_REFUSED])
        expect((await t.get(`/tables/${tableId}/carts`)).status).toBe(200)
    })

    it("an administrator holds every ability without being a member", async () => {
        const { as, latte } = await scaffold()
        const a = as(await authFor("admin"))
        expect((await a.get("/sales?from=2026-01-01&to=2026-01-02")).status).toBe(200)
        expect((await a.put(`/menu/${latte}`, { name: "Flat white" })).status).toBe(200)
    })
})

describe("who handles whom on the staff", () => {
    it("a manager adds, re-roles and removes the three below, never a manager", async () => {
        const { manager, till, floor, as, roles } = await scaffold()
        const m = as(manager)
        const newcomer = await authFor("customer")
        expect((await m.post("/staff", { email: newcomer.email, role: "kitchen" })).status).toBe(200)
        expect(refused(await m.post("/staff", { email: (await authFor("customer")).email, role: "manager" }))).toEqual([403, "Only the owner adds managers"])

        const moved = await m.put(`/staff/${till.user._id}`, { role: "floor" })
        expect(moved.status).toBe(200)
        expect(moved.body.members.find((x: { userId: string }) => x.userId === String(till.user._id)).role).toBe("floor")
        expect((await roles())[String(till.user._id)]).toBe("floor")
        expect(refused(await m.put(`/staff/${till.user._id}`, { role: "manager" }))).toEqual([403, "Only the owner changes a manager's role"])
        const other = await authFor("customer")
        expect(refused(await m.put(`/staff/${other.user._id}`, { role: "till" }))).toEqual([404, "Not a member of this shop"])
        expect((await m.delete(`/staff/${floor.user._id}`)).status).toBe(204)
    })

    it("a manager can't touch another manager; the owner can, but not themselves or by naming owner", async () => {
        const { owner, manager, till, as, roles } = await scaffold()
        const second = await authFor("customer")
        const o = as(owner)
        expect((await o.post("/staff", { email: second.email, role: "manager" })).status).toBe(200)
        const m = as(manager)
        expect(refused(await m.put(`/staff/${second.user._id}`, { role: "till" }))).toEqual([403, "Only the owner changes a manager's role"])
        expect(refused(await m.delete(`/staff/${second.user._id}`))).toEqual([403, "Only the owner removes a manager"])

        expect((await o.put(`/staff/${second.user._id}`, { role: "till" })).status).toBe(200)
        expect((await o.put(`/staff/${till.user._id}`, { role: "manager" })).status).toBe(200)
        expect(refused(await o.put(`/staff/${till.user._id}`, { role: "manager" }))).toEqual([409, "Already that role"])
        expect(refused(await o.put(`/staff/${owner.user._id}`, { role: "manager" }))).toEqual([403, "The owner's role changes by handing the shop over"])
        expect((await o.put(`/staff/${till.user._id}`, { role: "owner" })).status).toBe(400)
        expect((await roles())[String(second.user._id)]).toBe("till")
        expect((await roles())[String(owner.user._id)]).toBe("owner")
    })

    it("till, floor and kitchen handle nobody, themselves included, but may leave", async () => {
        const { till, floor, manager, as, roles } = await scaffold()
        const t = as(till)
        expect(refused(await t.post("/staff", { email: (await authFor("customer")).email, role: "floor" }))).toEqual([403, ROLE_REFUSED])
        // Asking about a manager gets the same message: the role is the reason, not the target.
        expect(refused(await t.post("/staff", { email: (await authFor("customer")).email, role: "manager" }))).toEqual([403, ROLE_REFUSED])
        expect(refused(await t.put(`/staff/${manager.user._id}`, { role: "till" }))).toEqual([403, ROLE_REFUSED])
        expect(refused(await t.put(`/staff/${floor.user._id}`, { role: "manager" }))).toEqual([403, ROLE_REFUSED])
        expect(refused(await t.delete(`/staff/${manager.user._id}`))).toEqual([403, ROLE_REFUSED])
        expect(refused(await t.put(`/staff/${floor.user._id}`, { role: "kitchen" }))).toEqual([403, ROLE_REFUSED])
        expect(refused(await t.put(`/staff/${till.user._id}`, { role: "floor" }))).toEqual([403, ROLE_REFUSED])
        expect(refused(await t.delete(`/staff/${floor.user._id}`))).toEqual([403, ROLE_REFUSED])
        expect((await t.delete(`/staff/${till.user._id}`)).status).toBe(204)
        expect((await roles())[String(till.user._id)]).toBeUndefined()
    })

    it("a re-role and a hand-over to the same member in the same instant leave the shop consistent", async () => {
        const { owner, till, as, roles } = await scaffold()
        const o = as(owner)
        const [reroled, handed] = await Promise.all([
            o.put(`/staff/${till.user._id}`, { role: "floor" }),
            o.put("/owner", { userId: String(till.user._id) }),
        ])
        expect(handed.status).toBe(200)
        // Landing first, the re-role went through and the hand-over followed;
        // landing second, it found the member no longer a till and asked for a retry.
        expect([200, 409]).toContain(reroled.status)
        if (reroled.status === 409) expect(reroled.body.message).toBe("The shop's staff changed, please retry")
        const after = await roles()
        expect(after[String(till.user._id)]).toBe("owner")
        expect(after[String(owner.user._id)]).toBe("manager")
        expect(Object.values(after).filter((r) => r === "owner")).toHaveLength(1)
    })
})
