import { describe, it, expect, beforeEach } from "@jest/globals"
import mongoose from "mongoose"
import "./setup"
import { agent, authFor } from "./helpers"
import OrderModel from "../services/orders/model"
import { bucketsOf, dayIn, daysBetween, isDay, startOfDay } from "../lib/days"

// The sales report (shops/controllers/salesControllers.ts) over orders written
// straight into the collection, dated either side of the clocks going forward
// (Europe/London, 29 March 2026 at 01:00 UTC), so every figure is asserted exactly.

const oid = () => new mongoose.Types.ObjectId()
const LATTE = oid()
const SEA_BASS = oid()
const T1 = String(oid())
const T2 = String(oid())
const PATIO = String(oid())

type Line = { menuId: mongoose.Types.ObjectId; name: string; category: string | null; unitPrice: number; qty: number; refundedQty?: number }
type Refund = { at: string; amount: number; status?: string; reason?: string }
type Fixture = {
    paidAt: string; amount: number; status?: string; provider?: string
    payerId: mongoose.Types.ObjectId; cartId?: mongoose.Types.ObjectId; tableId?: string; tableName?: string
    lines?: Line[]; refunds?: Refund[]
}
const order = (shopId: string, f: Fixture) => OrderModel.collection.insertOne({
    paymentId: oid(), cartId: f.cartId ?? oid(), cartOpenedAt: new Date(f.paidAt), cartVersion: 1,
    shopId: new mongoose.Types.ObjectId(shopId), tableId: f.tableId ?? T1, tableName: f.tableName ?? (f.tableId === T2 ? "T2" : "T1"),
    payerId: f.payerId, status: f.status ?? "completed", paidAt: new Date(f.paidAt), currency: "GBP", amount: f.amount,
    provider: f.provider ?? "paypal", providerCheckoutId: `CO-${Math.random()}`, providerPaymentId: "CAP",
    lines: (f.lines ?? []).map((l) => ({ refundedQty: 0, ...l })),
    refunds: (f.refunds ?? []).map((r) => ({ refundId: oid(), status: r.status ?? "completed", at: new Date(r.at), amount: r.amount, lines: [], ...(r.reason ? { reason: r.reason } : {}) })),
})

const shopFor = async (cookies: string[], body: object = { name: "Sales shop" }) => {
    const res = await agent().post("/shops").set("Cookie", cookies).send(body)
    expect(res.status).toBe(200)
    return res.body as { _id: string; timeZone: string }
}
const sales = (cookies: string[], shopId: string, query: Record<string, string>) =>
    agent().get(`/shops/${shopId}/sales`).set("Cookie", cookies).query(query)

// A week either side of the clock change, two diners, two tables and a third
// that only has a refund in the range, a renamed dish, a pending and a failed
// payment, a sale before the range refunded inside it.
const P1 = oid()
const P2 = oid()
const P3 = oid()
const seed = async (shopId: string) => {
    const C1 = oid()
    await Promise.all([
        // Saturday 28 March, 23:30 GMT: the 28th.
        order(shopId, { paidAt: "2026-03-28T23:30:00Z", amount: 10, payerId: P1, cartId: C1, lines: [{ menuId: LATTE, name: "Latte", category: "drinks", unitPrice: 2.5, qty: 4 }] }),
        // Same visit, earlier that day; the dish under an older name and price, with no category.
        order(shopId, { paidAt: "2026-03-28T12:00:00Z", amount: 3, payerId: P1, cartId: C1, lines: [{ menuId: SEA_BASS, name: "Seabass", category: null, unitPrice: 3, qty: 1 }] }),
        // Sunday 29 March 23:30 UTC is 00:30 BST on Monday the 30th. One unit refunded that evening.
        order(shopId, { paidAt: "2026-03-29T23:30:00Z", amount: 12.3, payerId: P2, tableId: T2, lines: [{ menuId: SEA_BASS, name: "Sea Bass", category: "food", unitPrice: 4.1, qty: 3, refundedQty: 1 }],
            refunds: [{ at: "2026-03-30T18:00:00Z", amount: 4.1, reason: "quality" }] }),
        // Tuesday 31 March, 23:59:59 BST: still the 31st.
        order(shopId, { paidAt: "2026-03-31T22:59:59Z", amount: 5, payerId: P1, provider: "stripe", lines: [{ menuId: LATTE, name: "Latte", category: "drinks", unitPrice: 2.5, qty: 2 }] }),
        // 1 April, 00:00 BST: out of the range.
        order(shopId, { paidAt: "2026-03-31T23:00:00Z", amount: 100, payerId: P1, lines: [{ menuId: LATTE, name: "Latte", category: "drinks", unitPrice: 2.5, qty: 40 }] }),
        // Awaiting its provider, and one that failed.
        order(shopId, { paidAt: "2026-03-30T12:00:00Z", amount: 50, status: "pending", payerId: P2 }),
        order(shopId, { paidAt: "2026-03-30T12:00:00Z", amount: 60, status: "failed", payerId: P2 }),
        // Before the range: P2's first visit, at a table since deleted, refunded
        // in the range (counted), with a refund still pending and one made after it (neither).
        order(shopId, { paidAt: "2026-03-01T12:00:00Z", amount: 20, payerId: P2, tableId: PATIO, tableName: "Patio",
            refunds: [{ at: "2026-03-30T10:00:00Z", amount: 6, reason: "long_wait" }, { at: "2026-03-30T10:30:00Z", amount: 1, status: "pending" }, { at: "2026-04-02T10:00:00Z", amount: 2 }] }),
        // In the period before the range: a third diner's only visit.
        order(shopId, { paidAt: "2026-03-25T12:00:00Z", amount: 7, payerId: P3, lines: [{ menuId: LATTE, name: "Latte", category: "drinks", unitPrice: 3.5, qty: 2 }] }),
    ])
}

const zero = (bucket: string) => ({
    bucket, gross: 0, refunds: 0, net: 0, orders: 0, visits: 0, diners: 0, newDiners: 0, units: 0,
    byCategory: { food: 0, drinks: 0, other: 0 }, byProvider: { paypal: 0, stripe: 0 },
})

describe("GET /shops/:shopId/sales", () => {
    let cookies: string[]
    let shopId: string
    beforeEach(async () => {
        cookies = (await authFor("shopMg")).cookies
        shopId = (await shopFor(cookies))._id
    })

    it("counts a till's way, in the shop's days, across the clocks going forward", async () => {
        await seed(shopId)
        const res = await sales(cookies, shopId, { from: "2026-03-28", to: "2026-03-31" })
        expect(res.status).toBe(200)
        expect(res.body.range).toEqual({ from: "2026-03-28", to: "2026-03-31", timeZone: "Europe/London", by: "day", days: 4 })
        expect(res.body.totals).toEqual({
            gross: 30.3, refunds: 10.1, net: 20.2, orders: 4, pendingOrders: 1, visits: 3, diners: 2, returningDiners: 1, units: 9,
            byProvider: { paypal: { gross: 25.3, orders: 3 }, stripe: { gross: 5, orders: 1 } },
        })
        expect(res.body.series).toEqual([
            { ...zero("2026-03-28"), gross: 13, net: 13, orders: 2, visits: 1, diners: 1, newDiners: 1, units: 5, byCategory: { food: 0, drinks: 10, other: 3 }, byProvider: { paypal: 13, stripe: 0 } },
            zero("2026-03-29"),
            { ...zero("2026-03-30"), gross: 12.3, refunds: 10.1, net: 2.2, orders: 1, visits: 1, diners: 1, units: 2, byCategory: { food: 12.3, drinks: 0, other: 0 }, byProvider: { paypal: 12.3, stripe: 0 } },
            { ...zero("2026-03-31"), gross: 5, net: 5, orders: 1, visits: 1, diners: 1, units: 2, byCategory: { food: 0, drinks: 5, other: 0 }, byProvider: { paypal: 0, stripe: 5 } },
        ])
        expect(res.body.heatmap).toEqual([
            { dow: 1, hour: 0, orders: 1, gross: 12.3 },
            { dow: 2, hour: 23, orders: 1, gross: 5 },
            { dow: 6, hour: 12, orders: 1, gross: 3 },
            { dow: 6, hour: 23, orders: 1, gross: 10 },
        ])
        expect(res.body.items).toEqual([
            { menuId: String(LATTE), name: "Latte", category: "drinks", unitPrice: 2.5, units: 6, refundedUnits: 0, revenue: 15 },
            { menuId: String(SEA_BASS), name: "Sea Bass", category: "food", unitPrice: 4.1, units: 3, refundedUnits: 1, revenue: 11.2 },
        ])
        expect(res.body.refunds).toEqual({
            count: 2,
            byReason: [{ reason: "long_wait", count: 1, amount: 6 }, { reason: "quality", count: 1, amount: 4.1 }],
            byHour: [{ hour: 11, count: 1, amount: 6 }, { hour: 19, count: 1, amount: 4.1 }],
        })
        expect(res.body.tables).toEqual([
            { tableId: T1, name: "T1", orders: 3, visits: 2, gross: 18, refunds: 0, net: 18 },
            { tableId: T2, name: "T2", orders: 1, visits: 1, gross: 12.3, refunds: 4.1, net: 8.2 },
            { tableId: PATIO, name: "Patio", orders: 0, visits: 0, gross: 0, refunds: 6, net: -6 },
        ])
        expect(res.body.previous).toBeUndefined()
    })

    it("compares with the period of the same length before", async () => {
        await seed(shopId)
        const res = await sales(cookies, shopId, { from: "2026-03-28", to: "2026-03-31", compare: "previous" })
        expect(res.status).toBe(200)
        expect(Object.keys(res.body.previous)).toEqual(["range", "totals", "series"])
        expect(res.body.previous.range).toEqual({ from: "2026-03-24", to: "2026-03-27", timeZone: "Europe/London", by: "day", days: 4 })
        expect(res.body.previous.totals).toMatchObject({ gross: 7, refunds: 0, net: 7, orders: 1, visits: 1, diners: 1, returningDiners: 0, units: 2 })
        expect(res.body.previous.series).toEqual([
            zero("2026-03-24"),
            { ...zero("2026-03-25"), gross: 7, net: 7, orders: 1, visits: 1, diners: 1, newDiners: 1, units: 2, byCategory: { food: 0, drinks: 7, other: 0 }, byProvider: { paypal: 7, stripe: 0 } },
            zero("2026-03-26"), zero("2026-03-27"),
        ])
    })

    it("buckets by week (from Monday) and by month, zero-filled, and picks `by` from the range", async () => {
        await seed(shopId)
        const weeks = await sales(cookies, shopId, { from: "2026-03-01", to: "2026-03-31", by: "week" })
        expect(weeks.status).toBe(200)
        expect(weeks.body.series.map((b: { bucket: string; gross: number; refunds: number }) => [b.bucket, b.gross, b.refunds])).toEqual([
            ["2026-02-23", 20, 0], ["2026-03-02", 0, 0], ["2026-03-09", 0, 0], ["2026-03-16", 0, 0], ["2026-03-23", 20, 0], ["2026-03-30", 17.3, 10.1],
        ])
        expect(weeks.body.totals).toMatchObject({ gross: 57.3, refunds: 10.1, net: 47.2, orders: 6, diners: 3, returningDiners: 0 })

        const months = await sales(cookies, shopId, { from: "2026-03-15", to: "2026-04-10", by: "month" })
        expect(months.body.series.map((b: { bucket: string; gross: number; refunds: number; orders: number }) => [b.bucket, b.gross, b.refunds, b.orders])).toEqual([
            ["2026-03-01", 37.3, 10.1, 5], ["2026-04-01", 100, 2, 1],
        ])

        expect((await sales(cookies, shopId, { from: "2026-01-01", to: "2026-04-02" })).body.range).toMatchObject({ by: "day", days: 92 })
        expect((await sales(cookies, shopId, { from: "2026-01-01", to: "2026-04-03", by: "" })).body.range).toMatchObject({ by: "week", days: 93 })
    })

    it("counts in the shop's own time zone", async () => {
        const nyc = await shopFor(cookies, { name: "Diner", timeZone: "America/New_York" })
        // 02:00 UTC on 2 April is 22:00 on Wednesday 1 April in New York.
        await order(nyc._id, { paidAt: "2026-04-02T02:00:00Z", amount: 9, payerId: P1 })
        const res = await sales(cookies, nyc._id, { from: "2026-04-01", to: "2026-04-01" })
        expect(res.status).toBe(200)
        expect(res.body.range.timeZone).toBe("America/New_York")
        expect(res.body.totals).toMatchObject({ gross: 9, orders: 1 })
        expect(res.body.heatmap).toEqual([{ dow: 3, hour: 22, orders: 1, gross: 9 }])
        expect((await sales(cookies, nyc._id, { from: "2026-04-02", to: "2026-04-02" })).body.totals.orders).toBe(0)
    })

    it("answers a shop with no sales with zeros and an empty series of the right length", async () => {
        const res = await sales(cookies, shopId, { from: "2026-10-01", to: "2026-10-03" })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({
            range: { from: "2026-10-01", to: "2026-10-03", timeZone: "Europe/London", by: "day", days: 3 },
            totals: { gross: 0, refunds: 0, net: 0, orders: 0, pendingOrders: 0, visits: 0, diners: 0, returningDiners: 0, units: 0, byProvider: { paypal: { gross: 0, orders: 0 }, stripe: { gross: 0, orders: 0 } } },
            series: [zero("2026-10-01"), zero("2026-10-02"), zero("2026-10-03")],
            heatmap: [], items: [], refunds: { count: 0, byReason: [], byHour: [] }, tables: [],
        })
    })

    it("refuses a bad range", async () => {
        const details = async (query: Record<string, string>) => {
            const res = await sales(cookies, shopId, query)
            expect(res.status).toBe(400)
            expect(res.body.message).toBe("Validation failed")
            return res.body.details
        }
        expect(await details({ to: "2026-03-31" })).toEqual([{ path: "from", message: expect.any(String) }])
        expect(await details({ from: "2026-02-30", to: "2026-03-31" })).toEqual([{ path: "from", message: "Not a calendar day" }])
        expect(await details({ from: "28/03/2026", to: "2026-03-31" })).toEqual([{ path: "from", message: "Not a day (YYYY-MM-DD)" }])
        expect(await details({ from: "2026-04-01", to: "2026-03-31" })).toEqual([{ path: "to", message: "Before `from`" }])
        expect(await details({ from: "2025-01-01", to: "2026-01-02" })).toEqual([{ path: "to", message: "More than 366 days after `from`" }])
        expect((await sales(cookies, shopId, { from: "2025-01-01", to: "2026-01-01" })).status).toBe(200)
        expect(await details({ from: "2026-03-01", to: "2026-03-31", by: "hour" })).toEqual([{ path: "by", message: expect.any(String) }])
        expect(await details({ from: "2026-03-01", to: "2026-03-31", compare: "next" })).toEqual([{ path: "compare", message: expect.any(String) }])
    })

    it("is the shop's manager's alone", async () => {
        expect((await agent().get(`/shops/${shopId}/sales`).query({ from: "2026-03-01", to: "2026-03-02" })).status).toBe(401)
        const diner = (await authFor("customer")).cookies
        expect((await sales(diner, shopId, { from: "2026-03-01", to: "2026-03-02" })).status).toBe(403)
        const other = (await authFor("shopMg")).cookies
        expect((await sales(other, shopId, { from: "2026-03-01", to: "2026-03-02" })).status).toBe(403)
        expect((await sales(cookies, String(oid()), { from: "2026-03-01", to: "2026-03-02" })).status).toBe(404)
    })

    it("reads orders through their indexes, never the whole collection", async () => {
        await seed(shopId)
        const admin = mongoose.connection.db!.admin()
        await admin.command({ setParameter: 1, notablescan: 1 })
        try {
            const res = await sales(cookies, shopId, { from: "2026-03-01", to: "2026-03-31", compare: "previous" })
            expect(res.status).toBe(200)
        } finally {
            await admin.command({ setParameter: 1, notablescan: 0 })
        }
    })
})

describe("GET /shops/:shopId/sales/export", () => {
    let cookies: string[]
    let shopId: string
    const TEA = oid()
    const csv = (query: Record<string, string>) => agent().get(`/shops/${shopId}/sales/export`).set("Cookie", cookies).query(query)
    beforeEach(async () => {
        cookies = (await authFor("shopMg")).cookies
        shopId = (await shopFor(cookies))._id
        await seed(shopId)
        // A table and a dish named to upset a spreadsheet.
        await order(shopId, { paidAt: "2026-03-29T12:00:00Z", amount: 2.2, payerId: P2, tableId: String(oid()), tableName: '=Window, "B"',
            lines: [{ menuId: TEA, name: 'Tea, "Earl Grey"', category: "drinks", unitPrice: 2.2, qty: 1 }] })
    })

    it("lists the payments of the range, in the shop's clock, escaped for a spreadsheet", async () => {
        const res = await csv({ from: "2026-03-28", to: "2026-03-31", table: "orders" })
        expect(res.status).toBe(200)
        expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8")
        expect(res.headers["content-disposition"]).toBe("attachment; filename=sales-shop-sales-2026-03-28-2026-03-31-orders.csv")
        expect(res.text).toBe("\uFEFF" + [
            "Paid at,Table,Provider,Status,Amount,Refunded,Net,Items",
            "2026-03-28 12:00,T1,PayPal,completed,3,0,3,1× Seabass",
            "2026-03-28 23:30,T1,PayPal,completed,10,0,10,4× Latte",
            `2026-03-29 13:00,"'=Window, ""B""",PayPal,completed,2.2,0,2.2,"1× Tea, ""Earl Grey"""`,
            "2026-03-30 00:30,T2,PayPal,completed,12.3,4.1,8.2,3× Sea Bass",
            "2026-03-30 13:00,T1,PayPal,pending,50,0,50,",
            "2026-03-31 23:59,T1,Card,completed,5,0,5,2× Latte",
        ].join("\r\n") + "\r\n")
    })

    it("lists the items by revenue, and the days zero-filled", async () => {
        const items = await csv({ from: "2026-03-28", to: "2026-03-31", table: "items" })
        expect(items.text).toBe("\uFEFF" + [
            "Item,Category,Unit price,Units,Refunded units,Revenue",
            "Latte,drinks,2.5,6,0,15",
            "Sea Bass,food,4.1,3,1,11.2",
            `"Tea, ""Earl Grey""",drinks,2.2,1,0,2.2`,
        ].join("\r\n") + "\r\n")
        const days = await csv({ from: "2026-03-28", to: "2026-03-31", table: "days" })
        expect(days.headers["content-disposition"]).toBe("attachment; filename=sales-shop-sales-2026-03-28-2026-03-31-days.csv")
        expect(days.text).toBe("\uFEFF" + [
            "Day,Gross,Refunds,Net,Orders,Visits,Diners,New diners,Units,Food,Drinks,Other,PayPal,Card",
            "2026-03-28,13,0,13,2,1,1,1,5,0,10,3,13,0",
            "2026-03-29,2.2,0,2.2,1,1,1,0,1,0,2.2,0,2.2,0",
            "2026-03-30,12.3,10.1,2.2,1,1,1,0,2,12.3,0,0,12.3,0",
            "2026-03-31,5,0,5,1,1,1,0,2,0,5,0,0,5",
        ].join("\r\n") + "\r\n")
    })

    it("needs the table and a good range, and is the shop's manager's alone", async () => {
        const missing = await csv({ from: "2026-03-28", to: "2026-03-31" })
        expect(missing.status).toBe(400)
        expect(missing.body.details).toEqual([{ path: "table", message: expect.any(String) }])
        expect((await csv({ from: "2026-03-28", to: "2026-03-31", table: "diners" })).status).toBe(400)
        expect((await csv({ from: "2026-04-01", to: "2026-03-31", table: "orders" })).body.details).toEqual([{ path: "to", message: "Before `from`" }])
        const other = (await authFor("shopMg")).cookies
        expect((await agent().get(`/shops/${shopId}/sales/export`).set("Cookie", other).query({ from: "2026-03-28", to: "2026-03-31", table: "orders" })).status).toBe(403)
        expect((await agent().get(`/shops/${shopId}/sales/export`).query({ from: "2026-03-28", to: "2026-03-31", table: "orders" })).status).toBe(401)
    })
})

describe("a shop's time zone", () => {
    it("is Europe/London unless set, an IANA name, and is shown to everyone", async () => {
        const { cookies } = await authFor("shopMg")
        const shop = await shopFor(cookies)
        expect(shop.timeZone).toBe("Europe/London")

        const bad = await agent().post("/shops").set("Cookie", cookies).send({ name: "Mars", timeZone: "Mars/Olympus" })
        expect(bad.status).toBe(400)
        expect(bad.body.details).toEqual([{ path: "timeZone", message: "Not a time zone name (an IANA name, like Europe/London)" }])

        const edited = await agent().put(`/shops/${shop._id}`).set("Cookie", cookies).send({ timeZone: "Asia/Tokyo" })
        expect(edited.status).toBe(200)
        expect(edited.body.timeZone).toBe("Asia/Tokyo")
        expect((await agent().get(`/shops/${shop._id}`)).body.timeZone).toBe("Asia/Tokyo")
        expect((await agent().put(`/shops/${shop._id}`).set("Cookie", cookies).send({ timeZone: "UTC" })).status).toBe(400)
    })
})

describe("days", () => {
    it("knows a calendar day and the arithmetic between days", () => {
        expect(["2026-02-28", "2024-02-29"].every(isDay)).toBe(true)
        expect(["2026-02-30", "2026-13-01", "2026-1-1", "26-01-01"].some(isDay)).toBe(false)
        expect(daysBetween("2026-10-01", "2026-10-01")).toBe(1)
        expect(daysBetween("2025-10-12", "2026-10-11")).toBe(365)
    })

    it("lists buckets from the Monday or the 1st on", () => {
        expect(bucketsOf("2026-10-11", "2026-10-13", "day")).toEqual(["2026-10-11", "2026-10-12", "2026-10-13"])
        expect(bucketsOf("2026-10-11", "2026-10-13", "week")).toEqual(["2026-10-05", "2026-10-12"])
        expect(bucketsOf("2026-11-30", "2027-01-01", "month")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"])
    })

    it("starts a day where the zone does, either side of the clocks changing", () => {
        expect(startOfDay("2026-03-29", "Europe/London").toISOString()).toBe("2026-03-29T00:00:00.000Z")
        expect(startOfDay("2026-03-30", "Europe/London").toISOString()).toBe("2026-03-29T23:00:00.000Z")
        expect(startOfDay("2026-10-25", "Europe/London").toISOString()).toBe("2026-10-24T23:00:00.000Z")
        expect(startOfDay("2026-10-26", "Europe/London").toISOString()).toBe("2026-10-26T00:00:00.000Z")
        expect(startOfDay("2026-04-01", "America/New_York").toISOString()).toBe("2026-04-01T04:00:00.000Z")
        expect(dayIn(new Date("2026-03-29T23:30:00Z"), "Europe/London")).toBe("2026-03-30")
        expect(dayIn(new Date("2026-03-29T23:30:00Z"), "America/New_York")).toBe("2026-03-29")
    })
})
