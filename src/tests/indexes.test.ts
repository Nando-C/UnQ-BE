import { jest, describe, it, expect, beforeAll, beforeEach } from "@jest/globals"

// Checkout's capture calls PayPal: mocked at the module boundary, as in serverCheckout.test.ts.
jest.mock("../lib/paypal", () => ({
    getOrder: jest.fn(),
    createOrder: jest.fn(),
    captureOrder: jest.fn(),
    refundCapture: jest.fn(),
    PayPalRefundRefused: jest.requireActual<typeof import("../lib/paypal")>("../lib/paypal").PayPalRefundRefused,
    PayPalCaptureRefused: jest.requireActual<typeof import("../lib/paypal")>("../lib/paypal").PayPalCaptureRefused,
}))
// And Stripe's, by the in-memory fake.
jest.mock("../lib/stripe", () => jest.requireActual<typeof import("./fakeStripe")>("./fakeStripe").stripeMock())

import request from "supertest"
import mongoose from "mongoose"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"
import CartModel from "../services/carts/model"
import ShopModel from "../services/shops/model"
import UserModel from "../services/users/model"
import MenuModel from "../services/menus/model"
import OrderModel from "../services/orders/model"
import { SHOP_DELETION_READ } from "../services/orders/sync"
import { googleUserFor } from "../services/auth/oauth"
import { getOrder, captureOrder } from "../lib/paypal"
import StripeCheckoutModel from "../services/carts/stripeCheckout"
import { sweepStripeCheckouts } from "../services/carts/stripeFinish"
import { fakeStripe } from "./fakeStripe"

// Most carts are kept for good, so a query that reads all of them, or all of a
// table's or a shop's past carts, gets slower with every party served. Each test
// gives its tables a long history (`history`), and every cart read in `run` must
// look at no more than a few carts or index keys. With `notablescan` on, MongoDB
// also refuses any query on any collection that would read the whole of it.
const MOST_EXAMINED = 10
const noScans = async <T>(run: () => Promise<T>): Promise<T> => {
    const db = mongoose.connection.db!
    const admin = db.admin()
    await db.command({ profile: 2 })
    await admin.command({ setParameter: 1, notablescan: 1 })
    let result: T
    try {
        result = await run()
    } finally {
        await admin.command({ setParameter: 1, notablescan: 0 })
        await db.command({ profile: 0 })
    }
    // Deleting a shop removes all its carts (a "remove"): that one reads them
    // all, and so does the check that their payments' orders are kept first.
    const reads = await db.collection("system.profile")
        .find({ ns: `${db.databaseName}.carts`, op: { $nin: ["insert", "remove"] }, "command.comment": { $ne: SHOP_DELETION_READ } })
        .toArray()
    await db.collection("system.profile").drop()
    const long = reads
        .filter((op) => (op.docsExamined ?? 0) > MOST_EXAMINED || (op.keysExamined ?? 0) > MOST_EXAMINED)
        .map((op) => `${JSON.stringify(op.command.filter ?? op.command.query ?? op.command.pipeline)}: ${op.docsExamined} carts, ${op.keysExamined} keys (${op.planSummary})`)
    expect(long).toEqual([])
    return result
}

// Carts closed days ago at a table, paid, with an old notice: what years of
// service leave behind. Inserted as they are stored, to keep their dates.
const HISTORY = 50
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000)
const history = (shopId: string, tableId: string, userId: mongoose.Types.ObjectId) =>
    CartModel.collection.insertMany(Array.from({ length: HISTORY }, (_, i) => ({
        userId: new mongoose.Types.ObjectId(String(userId)),
        shopId: new mongoose.Types.ObjectId(shopId),
        tableId,
        status: "closed",
        items: [],
        split: [],
        payments: [{ _id: new mongoose.Types.ObjectId(), status: "completed", provider: "paypal", lines: [] }],
        refunds: [{ _id: new mongoose.Types.ObjectId(), status: "completed", lines: [] }],
        notices: [{ _id: new mongoose.Types.ObjectId(), at: daysAgo(2 + i), message: "Paid" }],
        createdAt: daysAgo(2 + i),
        updatedAt: daysAgo(2 + i),
        __v: 0,
    })))

beforeEach(() => {
    jest.mocked(getOrder).mockReset()
    jest.mocked(captureOrder).mockReset()
})

// The indexes are built before any test runs, as they are long before traffic in production.
beforeAll(async () => {
    await Promise.all([CartModel.init(), ShopModel.init(), UserModel.init(), MenuModel.init(), OrderModel.init(), StripeCheckoutModel.init()])
})

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

// A shop with two tables, each with a long history, and a £3 latte.
const scaffold = async () => {
    const owner = await authFor("shopMg")
    const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
    const addTable = async (name: string) =>
        (await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name })).body._id as string
    const tableId = await addTable("T1")
    const otherTableId = await addTable("T2")
    const menuId = (
        await request(app)
            .post(`/shops/${shopId}/menu`)
            .set("Cookie", owner.cookies)
            .send({ name: "Latte", short_description: "Milky", price: 3, category: "drinks" })
    ).body._id as string
    const customer = await authFor("customer")
    await history(shopId, tableId, customer.user._id)
    await history(shopId, otherTableId, customer.user._id)
    return { owner, shopId, tableId, otherTableId, menuId, customer }
}

// A cart closed a few minutes ago at a table, with a notice for the table.
const closedCart = (shopId: string, tableId: string, userId: mongoose.Types.ObjectId) =>
    CartModel.create({
        userId,
        shopId,
        tableId,
        status: "closed",
        items: [],
        notices: [{ at: minutesAgo(5), message: "The staff closed this table" }],
    })

describe("no request reads a whole collection", () => {
    it("diners ordering, selecting and viewing their table", async () => {
        const { shopId, tableId, otherTableId, menuId, customer } = await scaffold()
        await closedCart(shopId, otherTableId, customer.user._id)

        await noScans(async () => {
            const added = await request(app)
                .post(`/carts/${shopId}/tables/${tableId}/addItem`)
                .set("Cookie", customer.cookies)
                .send({ menuId, qty: 2 })
            expect(added.status).toBe(200)
            const cartId = added.body._id

            const selected = await request(app)
                .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
                .set("Cookie", customer.cookies)
                .send({ menuId, qty: 1 })
            expect(selected.status).toBe(200)

            expect((await request(app).get("/carts/").set("Cookie", customer.cookies)).status).toBe(200)
            expect((await request(app).get(`/carts/tables/${tableId}`).set("Cookie", customer.cookies)).status).toBe(200)

            // No open cart: the closed one's notices are looked up instead.
            const closed = await request(app).get(`/carts/tables/${otherTableId}`).set("Cookie", customer.cookies)
            expect(closed.status).toBe(404)
            expect(closed.body.notices).toHaveLength(1)
        })
    })

    it("a diner paying with PayPal", async () => {
        const { shopId, tableId, menuId, customer } = await scaffold()
        const cartId = (
            await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", customer.cookies).send({ menuId, qty: 1 })
        ).body._id
        await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        jest.mocked(getOrder).mockResolvedValue({
            id: "ORDER-1",
            status: "APPROVED",
            purchase_units: [{ amount: { currency_code: "GBP", value: "3.00" }, custom_id: `${cartId}:${customer.user._id}` }],
        })
        jest.mocked(captureOrder).mockResolvedValue({
            id: "ORDER-1",
            status: "COMPLETED",
            purchase_units: [{
                amount: { currency_code: "GBP", value: "3.00" },
                payments: { captures: [{ id: "CAPTURE-1", status: "COMPLETED", amount: { currency_code: "GBP", value: "3.00" } }] },
            }],
        })

        // The capture first checks the PayPal order wasn't used on any cart
        // before; then the payment's order is written (a refused read would
        // only be logged, so its order is checked too).
        const paid = await noScans(() =>
            request(app)
                .post(`/carts/tables/${tableId}/${cartId}/captureCheckout`)
                .set("Cookie", customer.cookies)
                .send({ paypalOrderId: "ORDER-1" })
        )
        expect(paid.status).toBe(200)
        expect(await OrderModel.countDocuments({ cartId })).toBe(1)
    })

    it("a diner paying by card, the sweep, and their notices", async () => {
        fakeStripe.reset()
        const { shopId, tableId, menuId, customer } = await scaffold()
        const cartId = (
            await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", customer.cookies).send({ menuId, qty: 2 })
        ).body._id
        await request(app)
            .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
            .set("Cookie", customer.cookies)
            .send({ menuId, qty: 1 })
        // Another card payment, older, the diner left: the sweep finishes it.
        const left = (await request(app).post(`/carts/tables/${tableId}/${cartId}/createStripeCheckout`).set("Cookie", customer.cookies)).body.paymentIntentId
        fakeStripe.authorise(left)
        await StripeCheckoutModel.collection.updateOne({ _id: left }, { $set: { createdAt: minutesAgo(11) } })

        await noScans(async () => {
            expect(await sweepStripeCheckouts()).toMatchObject({ finished: 1 })
            await request(app)
                .post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`)
                .set("Cookie", customer.cookies)
                .send({ menuId, qty: 1 })
            const created = await request(app).post(`/carts/tables/${tableId}/${cartId}/createStripeCheckout`).set("Cookie", customer.cookies)
            expect(created.status).toBe(200)
            fakeStripe.authorise(created.body.paymentIntentId)
            const paid = await request(app)
                .post(`/carts/tables/${tableId}/${cartId}/captureStripeCheckout`)
                .set("Cookie", customer.cookies)
                .send({ paymentIntentId: created.body.paymentIntentId })
            expect(paid.status).toBe(200)
            // The table's cart is paid off: the 404 body, with the notice of the one the sweep finished.
            const view = await request(app).get(`/carts/tables/${tableId}`).set("Cookie", customer.cookies)
            expect(view.body.notices.map((n: { message: string }) => n.message)).toContain("Your card payment of £3.00 went through")
        })
    })

    it("a manager's table sheets and statuses", async () => {
        const { owner, shopId, tableId, otherTableId, menuId, customer } = await scaffold()
        await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", customer.cookies).send({ menuId, qty: 1 })
        await closedCart(shopId, otherTableId, customer.user._id)

        await noScans(async () => {
            expect((await request(app).get(`/shops/${shopId}/tables/status`).set("Cookie", owner.cookies)).status).toBe(200)
            const open = await request(app).get(`/shops/${shopId}/tables/${tableId}/carts`).set("Cookie", owner.cookies)
            expect(open.body.open).toHaveLength(1)
            const closed = await request(app).get(`/shops/${shopId}/tables/${otherTableId}/carts`).set("Cookie", owner.cookies)
            expect(closed.body.recentlyClosed).toHaveLength(1)
        })
    })

    it("a manager deleting a table, then their shop, then their account", async () => {
        const { owner, shopId, tableId, otherTableId, customer } = await scaffold()
        await closedCart(shopId, otherTableId, customer.user._id)

        await noScans(async () => {
            // A table whose cart closed lately is kept as deleted, and listed on /shops/me.
            expect((await request(app).delete(`/shops/${shopId}/tables/${otherTableId}`).set("Cookie", owner.cookies)).status).toBe(204)
            const mine = await request(app).get("/shops/me").set("Cookie", owner.cookies)
            expect(mine.body[0].deletedTables[0].recentCartsUntil).toBeDefined()

            // While they have a shop, the account stays.
            const account = await request(app).delete("/users/me").set("Cookie", owner.cookies).send({ currentPassword: owner.password })
            expect(account.status).toBe(409)
        })

        // Refused while a table has an open cart, then deleted with its menu and carts.
        await CartModel.create({ userId: customer.user._id, shopId, tableId, items: [] })
        await noScans(async () => {
            expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(409)
        })
        await CartModel.deleteMany({ status: "open" })
        await noScans(async () => {
            expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)
        })
        expect(await CartModel.countDocuments()).toBe(0)
        expect(await MenuModel.countDocuments()).toBe(0)
    })

    it("signing in with Google", async () => {
        const profile = (id: string, email: string) =>
            ({ id, displayName: "Ana", emails: [{ value: email, verified: true }] }) as Parameters<typeof googleUserFor>[0]

        await noScans(async () => {
            const created = await googleUserFor(profile("g-1", "ana@example.com"))
            const again = await googleUserFor(profile("g-1", "ana@example.com"))
            expect(String(again?._id)).toBe(String(created?._id))
        })
    })
})

describe("an existing database's indexes", () => {
    // Drops an index if it's there; any failure but "not found" (27) stops the test.
    const dropIfThere = (name: string) =>
        CartModel.collection.dropIndex(name).catch((error: { code?: number }) => {
            if (error.code !== 27) throw error
        })
    const LEGACY = ["paypalOrderId_1", "paypalOrderId_1__id_1"]

    // Databases hold an earlier index for the legacy order id: `paypalOrderId_1`
    // unique (checkout's first replay guard, before order ids moved to
    // `paypalOrderIds`) or not (built from S29 until 2026-10-06), or
    // `paypalOrderId_1__id_1` (briefly, 2026-10-06), or none (a new database).
    // The cart indexes build over each, the lookup's own index among them.
    it.each([
        ["none, a new database", null, null],
        ["unique, from July", { paypalOrderId: 1 }, { unique: true, sparse: true }],
        ["not unique, from S29", { paypalOrderId: 1 }, { sparse: true }],
        ["with _id, from 2026-10-06", { paypalOrderId: 1, _id: 1 }, { sparse: true }],
    ])("builds the cart indexes over an earlier order id index (%s)", async (_, keys, options) => {
        // As a deploy meets it: the earlier index there, the new one not yet.
        for (const name of [...LEGACY, "paypalOrderId_-1"]) await dropIfThere(name)
        const earlier = keys && await CartModel.collection.createIndex(keys, options ?? {})
        try {
            await expect(CartModel.createIndexes()).resolves.toBeUndefined()
            expect((await CartModel.collection.indexes()).map((i) => i.name)).toContain("paypalOrderId_-1")
        } finally {
            // Back to the schema's indexes alone, whatever happened above.
            if (earlier) await dropIfThere(earlier)
            await CartModel.createIndexes()
        }
    })

    // With no earlier index, so only the new one can serve it: checkout's
    // replay check (orderAlreadyUsed) reads no cart collection whole, legacy
    // carts included, and its chosen plan uses the new index.
    it("serves the legacy replay lookup by its own index", async () => {
        for (const name of LEGACY) await dropIfThere(name)
        await CartModel.createIndexes()
        await CartModel.collection.insertOne({ userId: new mongoose.Types.ObjectId(), tableId: "t-old", status: "closed", items: [], paypalOrderId: "ORDER-OLD" })
        const lookup = { $or: [{ paypalOrderIds: "ORDER-OLD" }, { paypalOrderId: "ORDER-OLD" }] }

        expect(await noScans(() => CartModel.exists(lookup))).toBeTruthy()
        const plan = (await CartModel.find(lookup).explain()) as unknown as { queryPlanner: { winningPlan: unknown } }
        expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('"indexName":"paypalOrderId_-1"')
    })
})
