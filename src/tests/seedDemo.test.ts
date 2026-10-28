import { describe, it, expect, beforeEach } from "@jest/globals"
import request from "supertest"
import mongoose from "mongoose"
import "./setup"
import app from "../server"
import { cookiesFrom } from "./helpers"
import { seedDemo, DEMO_SHOP_ID, DEMO_TABLE_ID, DEMO_MANAGER_EMAIL, DEMO_DINER_EMAIL, DEMO_STAFF_EMAIL, DEMO_TILL_EMAIL, DEMO_KITCHEN_EMAIL } from "../scripts/demo"
import UserModel from "../services/users/model"
import ShopModel from "../services/shops/model"
import MenuModel from "../services/menus/model"
import CartModel from "../services/carts/model"
import OrderModel from "../services/orders/model"
import StripeCheckoutModel from "../services/carts/stripeCheckout"
import PaybackModel from "../services/payments/payback"
import { addDays, dayIn, instantOf, startOfDay } from "../lib/days"

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

    it("keeps an account that holds the id a newer demo account would be given", async () => {
        // A database seeded before the café's second manager existed: Alex's
        // address is unknown, and the id the sequence gives Alex belongs to
        // another account. That account stays as it is; Alex gets another id.
        const alex = (await UserModel.findOne({ email: DEMO_STAFF_EMAIL }))!
        await UserModel.deleteOne({ _id: alex._id })
        await UserModel.create({ _id: alex._id, email: "someone.else@example.net", name: "Someone", surname: "Else", role: "customer" })

        await seedDemo({ ...passwords, now: NOW })

        const other = await UserModel.findById(alex._id).lean()
        expect(other).toMatchObject({ email: "someone.else@example.net", name: "Someone" })
        const again = (await UserModel.findOne({ email: DEMO_STAFF_EMAIL }).lean())!
        expect(again).toMatchObject({ name: "Alex", role: "customer" })
        expect(String(again._id)).not.toBe(String(alex._id))
        const shop = await ShopModel.findById(DEMO_SHOP_ID).lean()
        expect(shop!.members.map((m) => String(m.userId))).toContain(String(again._id))
    }, 120_000)

    it("writes three shops, their tables and menus, forty-four users and the history", async () => {
        expect(summary).toMatchObject({ shops: 3, tables: 14, users: 44, paybacks: 2 })
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

    it("gives the history the shapes a sales page shows", async () => {
        const shop = new mongoose.Types.ObjectId(DEMO_SHOP_ID)
        const inZone = { date: "$paidAt", timezone: "Europe/London" }
        const sales = (match: object) => OrderModel.aggregate<{ _id: unknown; n: number }>([{ $match: { shopId: shop, status: "completed", ...match } }, { $group: { _id: null, n: { $sum: 1 } } }]).then((r) => r[0]?.n ?? 0)
        // Peaks: visits start in the café's two busy spells and pay within the
        // hour, so the four peak hours hold well over the five around them
        // (they get two thirds of the visits, spread over fewer hours).
        const byHour = await OrderModel.aggregate<{ _id: number; n: number }>([{ $match: { shopId: shop, status: "completed" } }, { $group: { _id: { $hour: inZone }, n: { $sum: 1 } } }])
        const hour = (h: number) => byHour.find((b) => b._id === h)?.n ?? 0
        expect(hour(9) + hour(10) + hour(13) + hour(14)).toBeGreaterThan(1.4 * (hour(8) + hour(11) + hour(12) + hour(15) + hour(16)))
        // A rise over the 90 days: the last four weeks outsell the first four
        // (whole weeks, so both windows hold the same number of weekends).
        const days = (ago: number) => new Date(NOW.getTime() - ago * 86_400_000)
        expect(await sales({ paidAt: { $gte: days(29) } })).toBeGreaterThan(1.15 * await sales({ paidAt: { $gte: days(91), $lt: days(63) } }))
        // Regulars and passers-by: forty diners, a dozen of whom bring most visits.
        const payers = await OrderModel.aggregate<{ _id: unknown; n: number }>([{ $match: { status: "completed" } }, { $group: { _id: "$payerId", n: { $sum: 1 } } }, { $sort: { n: -1 } }])
        expect(payers.length).toBeGreaterThanOrEqual(34)
        // New faces keep coming, at every shop: diners whose first payment
        // there falls in the last 30 days, and at least one on the shop's
        // last open day before today (the history ends yesterday; today holds
        // the live states), which is within the week: the pop-up opens on
        // Saturdays only, so on a Saturday that day is seven days ago.
        const firsts = await OrderModel.aggregate<{ _id: { shop: unknown; payer: unknown }; first: Date }>([{ $match: { status: "completed" } }, { $group: { _id: { shop: "$shopId", payer: "$payerId" }, first: { $min: "$paidAt" } } }])
        const todayStart = startOfDay(dayIn(NOW, "Europe/London"), "Europe/London")
        const lastSales = await OrderModel.aggregate<{ _id: unknown; at: Date }>([{ $match: { status: "completed", paidAt: { $lt: todayStart } } }, { $group: { _id: "$shopId", at: { $max: "$paidAt" } } }])
        for (const s of await ShopModel.find().lean()) {
            const here = firsts.filter((f) => String(f._id.shop) === String(s._id))
            const lastSale = lastSales.find((l) => String(l._id) === String(s._id))!.at
            const lastOpenDay = startOfDay(dayIn(lastSale, "Europe/London"), "Europe/London")
            expect({ shop: s.name, month: here.filter((f) => f.first >= days(30)).length >= 3, week: lastSale >= days(8), newcomer: here.some((f) => f.first >= lastOpenDay) }).toEqual({ shop: s.name, month: true, week: true, newcomer: true })
        }
        const total = payers.reduce((s, p) => s + p.n, 0)
        expect(payers.slice(0, 12).reduce((s, p) => s + p.n, 0)).toBeGreaterThan(0.6 * total)
        // The pastry launched in week six: no sale before that day began (in
        // the shop's zone; the seed's days are whole days, not hours), plenty after.
        const nata = (await MenuModel.findOne({ name: "Pastel de Nata" }).lean())!
        const launch = startOfDay(addDays(dayIn(NOW, "Europe/London"), -48), "Europe/London")
        expect(await OrderModel.countDocuments({ "lines.menuId": nata._id, paidAt: { $lt: launch } })).toBe(0)
        expect(await OrderModel.countDocuments({ "lines.menuId": nata._id })).toBeGreaterThan(20)
        // Refund causes weighted: on Friday and Saturday evenings, most are for the wait.
        const evenings = await OrderModel.aggregate<{ _id: string; n: number }>([
            { $unwind: "$refunds" },
            { $match: { $expr: { $and: [{ $in: [{ $isoDayOfWeek: { date: "$refunds.at", timezone: "Europe/London" } }, [5, 6]] }, { $gte: [{ $hour: { date: "$refunds.at", timezone: "Europe/London" } }, 18] }] } } },
            { $group: { _id: "$refunds.reason", n: { $sum: 1 } } }, { $sort: { n: -1 } },
        ])
        expect(evenings[0]).toMatchObject({ _id: "long_wait" })
        expect(evenings[0].n).toBeGreaterThan(evenings.reduce((s, r) => s + r.n, 0) / 2)
        // The bad week: fewer sales than the weeks either side. Counted on the
        // shop's calendar days, as the seed halves them: a window slid from the
        // test's clock lets part of an ordinary day in.
        const dayStart = (ago: number) => startOfDay(addDays(dayIn(NOW, "Europe/London"), -ago), "Europe/London")
        const week = (from: number) => sales({ paidAt: { $gte: dayStart(from), $lt: dayStart(from - 7) } })
        expect(await week(38)).toBeLessThan(0.8 * Math.min(await week(45), await week(31)))
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

    it("gives every shop an owner, and the café a manager, a till and a kitchen with no sign-in", async () => {
        const sam = (await UserModel.findOne({ email: DEMO_MANAGER_EMAIL }).lean())!
        const alex = (await UserModel.findOne({ email: DEMO_STAFF_EMAIL }).lean())!
        const kim = (await UserModel.findOne({ email: DEMO_TILL_EMAIL }).lean())!
        const jo = (await UserModel.findOne({ email: DEMO_KITCHEN_EMAIL }).lean())!
        expect(alex).toMatchObject({ role: "customer", createdBy: sam._id })
        expect(kim).toMatchObject({ role: "customer", createdBy: sam._id })
        expect(jo).toMatchObject({ role: "customer", createdBy: alex._id })
        for (const staff of [alex, kim, jo]) expect(staff.password).toBeUndefined()
        for (const shop of await ShopModel.find().lean()) {
            expect(String(shop.ownerId)).toBe(String(sam._id))
            expect(shop.members[0]).toMatchObject({ userId: sam._id, role: "owner" })
            const cafe = String(shop._id) === DEMO_SHOP_ID
            expect(shop.shopMg.map(String)).toEqual(cafe ? [sam, alex, kim, jo].map((u) => String(u._id)) : [String(sam._id)])
            expect(shop.members).toHaveLength(cafe ? 4 : 1)
            if (cafe) {
                expect(shop.members[1]).toMatchObject({ userId: alex._id, role: "manager", addedBy: sam._id })
                expect(shop.members[2]).toMatchObject({ userId: kim._id, role: "till", addedBy: sam._id })
                expect(shop.members[3]).toMatchObject({ userId: jo._id, role: "kitchen", addedBy: alex._id })
            }
        }
        // As the staff page reads it.
        const cookies = await login(DEMO_MANAGER_EMAIL, passwords.managerPassword)
        const staff = await request(app).get(`/shops/${DEMO_SHOP_ID}/staff`).set("Cookie", cookies)
        expect(staff.status).toBe(200)
        expect(staff.body.members.map((m: { role: string; name: string; email: string }) => [m.role, m.name, m.email]))
            .toEqual([["owner", "Sam", DEMO_MANAGER_EMAIL], ["manager", "Alex", DEMO_STAFF_EMAIL], ["till", "Kim", DEMO_TILL_EMAIL], ["kitchen", "Jo", DEMO_KITCHEN_EMAIL]])
    })

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

    it("run at night, still writes every order within its shop's hours", async () => {
        // The live states are placed at the latest moment each shop was open,
        // so a report's hours are the shop's whatever the clock the seed ran on
        // (a visit opened at last orders pays within the closing hour).
        await seedDemo({ ...passwords, now: instantOf(dayIn(NOW, "Europe/London"), 0, 30, "Europe/London") })
        for (const [name, from, to] of [["Rocketlit", 8, 16], ["Marlow Street Kitchen", 12, 22], ["Saturday Market Pop-up", 10, 16]] as const) {
            const shop = (await ShopModel.findOne({ name }).lean())!
            const hours = await OrderModel.aggregate<{ _id: number }>([{ $match: { shopId: shop._id, status: "completed" } }, { $group: { _id: { $hour: { date: "$paidAt", timezone: "Europe/London" } } } }])
            expect({ name, outside: hours.map((h) => h._id).filter((h) => h < from || h > to) }).toEqual({ name, outside: [] })
        }
    })
})
