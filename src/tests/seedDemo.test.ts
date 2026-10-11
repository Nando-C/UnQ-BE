import { describe, it, expect, beforeEach } from "@jest/globals"
import request from "supertest"
import mongoose from "mongoose"
import "./setup"
import app from "../server"
import { cookiesFrom } from "./helpers"
import { seedDemo, DEMO_SHOP_ID, DEMO_TABLE_ID, DEMO_MANAGER_EMAIL, DEMO_DINER_EMAIL } from "../scripts/demo"
import UserModel from "../services/users/model"
import ShopModel from "../services/shops/model"
import MenuModel from "../services/menus/model"
import CartModel from "../services/carts/model"
import OrderModel from "../services/orders/model"
import StripeCheckoutModel from "../services/carts/stripeCheckout"
import PaybackModel from "../services/payments/payback"

// The demo seed (src/scripts/demo.ts): what it writes, that a rerun writes the
// same, and that the app reads it as the demo is meant to look.

const MODELS = [UserModel, ShopModel, MenuModel, CartModel, OrderModel, StripeCheckoutModel, PaybackModel]
// The seed's reference time, taken once: the same for every run in this file,
// and today's, since the manager's page keeps a deleted table's closed carts
// for a day measured against the real clock.
const NOW = new Date()
const passwords = { managerPassword: "demo-manager-pw", dinerPassword: "demo-diner-pw" }

// Every document of every collection, as JSON, in a fixed order.
const everything = async () => {
    const out: Record<string, unknown[]> = {}
    for (const model of MODELS) out[model.modelName] = await (model as typeof UserModel).find().sort({ _id: 1 }).lean()
    const all = JSON.parse(JSON.stringify(out)) as Record<string, Record<string, unknown>[]>
    // Orders are written by the app's sync, which draws their ids: compared by
    // payment, without them.
    all.Order = all.Order.map((order) => { const { _id, ...rest } = order; void _id; return rest }).sort((a, b) => String(a.paymentId).localeCompare(String(b.paymentId)))
    return all
}

const login = async (email: string, password: string) => {
    const res = await request(app).post("/auth/login").send({ email, password })
    expect(res.status).toBe(200)
    return cookiesFrom(res)
}

describe("the demo seed", () => {
    let summary: Awaited<ReturnType<typeof seedDemo>>
    let first: Awaited<ReturnType<typeof everything>>

    // setup.ts empties every collection after each test, so each starts from
    // a fresh seed (the unique indexes built first, as the runner builds them).
    beforeEach(async () => {
        for (const model of MODELS) await model.init()
        summary = await seedDemo({ ...passwords, now: NOW })
        first = await everything()
    }, 120_000)

    it("writes three shops, their tables and menus, nine users and the history", async () => {
        expect(summary).toMatchObject({ shops: 3, tables: 14, users: 9, paybacks: 2 })
        expect(summary.menuItems).toBe(await MenuModel.countDocuments())
        expect(summary.carts).toBe(await CartModel.countDocuments())
        expect(summary.carts).toBeGreaterThan(500)
        // Every payment has its order, through the real sync.
        expect(summary.payments).toBe(await OrderModel.countDocuments())
        expect(summary.orders.created).toBe(summary.payments)
        // Sold-out and deleted items exist, and a deleted one is off its shop's menu.
        const deleted = await MenuModel.find({ deletedFrom: { $exists: true } }).lean()
        expect(deleted.length).toBe(2)
        for (const item of deleted) expect(await ShopModel.exists({ menu: item._id })).toBeNull()
        expect(await MenuModel.countDocuments({ available: false, deletedFrom: { $exists: false } })).toBe(3)
    })

    it("run again, writes the same documents", async () => {
        const again = await seedDemo({ ...passwords, now: NOW })
        expect(again).toEqual(summary)
        const second = await everything()
        // Users are found by email and left alone (their timestamps included).
        expect(second).toEqual(first)
    }, 120_000)

    it("rotates a password only when it changes, and both sign-ins work", async () => {
        const before = (await UserModel.findOne({ email: DEMO_DINER_EMAIL }).lean())!.password
        await seedDemo({ ...passwords, dinerPassword: "a-new-one", now: NOW })
        expect((await UserModel.findOne({ email: DEMO_DINER_EMAIL }).lean())!.password).not.toBe(before)
        await login(DEMO_DINER_EMAIL, "a-new-one")
        await login(DEMO_MANAGER_EMAIL, passwords.managerPassword)
        // Back to the suite's password for the tests below.
        await seedDemo({ ...passwords, now: NOW })
    }, 120_000)

    it("leaves what it doesn't own alone", async () => {
        const other = await ShopModel.create({ name: "Someone else's", shopMg: [new mongoose.Types.ObjectId()], menu: [] })
        const cart = await CartModel.create({ userId: new mongoose.Types.ObjectId(), shopId: other._id, tableId: String(new mongoose.Types.ObjectId()), items: [] })
        await seedDemo({ ...passwords, now: NOW })
        expect(await ShopModel.exists({ _id: other._id })).not.toBeNull()
        expect(await CartModel.exists({ _id: cart._id })).not.toBeNull()
        await ShopModel.deleteOne({ _id: other._id })
        await CartModel.deleteOne({ _id: cart._id })
    }, 120_000)

    it("shows the demo shop's tables as the manager's page expects", async () => {
        const cookies = await login(DEMO_MANAGER_EMAIL, passwords.managerPassword)
        const mine = await request(app).get("/shops/me").set("Cookie", cookies)
        expect(mine.status).toBe(200)
        expect(mine.body).toHaveLength(3)
        const rocketlit = mine.body.find((s: { _id: string }) => s._id === DEMO_SHOP_ID)
        expect(rocketlit.tables.map((t: { name: string }) => t.name)).toEqual(["Fire Place 🔥", "Window", "Garden 1", "Garden 2", "Bar"])
        // The deleted table still shows: a cart on it was refunded two hours ago.
        expect(rocketlit.deletedTables).toHaveLength(1)
        expect(rocketlit.deletedTables[0]).toMatchObject({ name: "Terrace" })
        expect(rocketlit.deletedTables[0].recentCartsUntil).toBeDefined()

        const status = await request(app).get(`/shops/${DEMO_SHOP_ID}/tables/status`).set("Cookie", cookies)
        expect(status.status).toBe(200)
        const byName = Object.fromEntries(status.body.map((t: { name: string }) => [t.name, t]))
        expect(byName["Fire Place 🔥"]).toMatchObject({ state: "ordering", attention: [] })
        expect(byName["Window"]).toMatchObject({ state: "waitingToPay" })
        expect(byName["Window"].attention).toContain("staleSelection")
        expect(byName["Garden 1"]).toMatchObject({ state: "partlyPaid" })
        expect(byName["Garden 1"].attention).toContain("soldOut")
        expect(byName["Garden 2"]).toMatchObject({ state: "free" })
        expect(byName["Garden 2"].attention).toContain("payBack")
        expect(byName["Bar"].attention).toContain("paymentPending")

        // Garden 2's sheet: the owed pay-back; Terrace's: the refunded cart.
        const garden2 = rocketlit.tables.find((t: { name: string }) => t.name === "Garden 2")
        const sheet = await request(app).get(`/shops/${DEMO_SHOP_ID}/tables/${garden2._id}/carts`).set("Cookie", cookies)
        expect(sheet.body.paybacks).toHaveLength(1)
        expect(sheet.body.paybacks[0]).toMatchObject({ kind: "refundRefused", owed: true, userId: { name: "Grace" } })
        const terrace = await request(app).get(`/shops/${DEMO_SHOP_ID}/tables/${rocketlit.deletedTables[0]._id}/carts`).set("Cookie", cookies)
        expect(terrace.body.recentlyClosed).toHaveLength(1)
        expect(terrace.body.recentlyClosed[0].refunds[0]).toMatchObject({ status: "completed", reason: "quality" })
    })

    it("serves the QR table's cart to a diner who hasn't signed in", async () => {
        const res = await request(app).get(`/carts/tables/${DEMO_TABLE_ID}`)
        expect(res.status).toBe(200)
        expect(res.body.items).toHaveLength(2)
        expect(res.body.payments).toBeUndefined()
    })

    it("holds together under the app's rules", async () => {
        // One open cart per table, and every open cart on a table of its shop.
        const open = await CartModel.find({ status: "open" }).lean()
        expect(new Set(open.map((c) => c.tableId)).size).toBe(open.length)
        // Every Stripe payment has its record, and every refunded unit left the cart.
        const carts = await CartModel.find().lean()
        for (const cart of carts) {
            for (const id of cart.stripePaymentIntentIds ?? []) expect(await StripeCheckoutModel.exists({ _id: id, cartId: cart._id })).not.toBeNull()
            for (const item of cart.items) {
                expect(item.qty).toBeGreaterThan(0)
                expect(item.qtyPayed).toBeLessThanOrEqual(item.qty)
            }
            for (const payment of cart.payments) {
                expect(payment.amount).toBeCloseTo(payment.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0), 2)
            }
        }
        // Both kinds of pay-back, one owed and one done.
        expect(await PaybackModel.countDocuments({ owed: true })).toBe(1)
        expect(await PaybackModel.countDocuments({ doneAs: "paidBack" })).toBe(1)
        // A refund of each status, and more than one reason.
        expect(await CartModel.countDocuments({ "refunds.status": "failed" })).toBeGreaterThan(0)
        expect((await CartModel.distinct("refunds.reason")).length).toBeGreaterThan(3)
    })
})
