import { TController } from "../../../typings/controllers"
import createError from "http-errors"
import mongoose, { PipelineStage } from "mongoose"
import ShopModel from "../model"
import OrderModel from "../../orders/model"
import { PAYMENT_PROVIDERS } from "../../carts/model"
import { fromPence, toPence } from "../../../lib/money"
import { Day, GroupBy, addDays, bucketsOf, clockIn, daysBetween, startOfDay } from "../../../lib/days"
import { SalesExportQuery, SalesQuery } from "../schemas"

// The sales report: a shop's orders (orders/model.ts) over a range of its own
// days, counted as a till would. Gross sales are completed payments by the day
// paid; refunds count on the day they were made (completed only), so a refund
// made in March of a January sale lowers March and leaves January as it was;
// net is the difference. Orders are completed payments, visits distinct carts,
// diners distinct payers; a returning diner had paid at this shop before the
// range began. Items are counted net of refunded units whenever those were
// refunded, under the name and price diners saw last. Every sum is made in
// pence and sent in pounds.

type Range = { from: Day; to: Day; timeZone: string; by: GroupBy }
// The range as instants: from the first day's start to the day after the last's.
const boundsOf = ({ from, to, timeZone }: Range) => ({ start: startOfDay(from, timeZone), end: startOfDay(addDays(to, 1), timeZone) })

// `by` when the request leaves it to the range: days up to about a quarter,
// then weeks.
const DAYS_BY_DAY = 92
const groupBy = (from: Day, to: Day): GroupBy => (daysBetween(from, to) <= DAYS_BY_DAY ? "day" : "week")

// A pounds field summed as pence, so 3 × £4.10 doesn't end in .299999.
const pence = (expr: unknown) => ({ $round: [{ $multiply: [expr, 100] }, 0] })
const gross = { $sum: pence("$amount") }
const lineUnits = { $subtract: ["$lines.qty", "$lines.refundedQty"] }
// An order's units, net of refunds, over its lines.
const orderUnits = { $sum: { $map: { input: "$lines", as: "l", in: { $subtract: ["$$l.qty", "$$l.refundedQty"] } } } }
// Completed orders summed, as a whole (`_id: null`) or per bucket.
const summed = (_id: unknown): PipelineStage.FacetPipelineStage[] => [
    completed,
    { $group: { _id, gross, orders: { $sum: 1 }, carts: { $addToSet: "$cartId" }, payers: { $addToSet: "$payerId" }, units: { $sum: orderUnits } } },
    { $project: { gross: 1, orders: 1, units: 1, visits: { $size: "$carts" }, diners: { $size: "$payers" } } },
]
// The first day of the bucket a date falls in, in the shop's zone.
const completed = { $match: { status: "completed" } }
const bucketOf = (field: string, { by, timeZone }: Range) => ({
    $dateToString: { format: "%Y-%m-%d", timezone: timeZone, date: { $dateTrunc: { date: field, unit: by, timezone: timeZone, startOfWeek: "monday" } } },
})


type Bucketed<T> = T & { _id: string }
type OrdersFacets = {
    totals: { gross: number; orders: number; visits: number; diners: number; units: number }[]
    pending: { n: number }[]
    byProvider: { _id: string; gross: number; orders: number }[]
    series: Bucketed<{ gross: number; orders: number; visits: number; diners: number; units: number }>[]
    seriesByProvider: { _id: { bucket: string; name: string }; gross: number }[]
    seriesByCategory: { _id: { bucket: string; name: string }; gross: number }[]
    payers: { _id: mongoose.Types.ObjectId; first: string }[]
    heatmap: { _id: { dow: number; hour: number }; orders: number; gross: number }[]
    items: { _id: mongoose.Types.ObjectId; name: string; category: string | null; unitPrice: number; units: number; refundedUnits: number; revenue: number }[]
    tables: { _id: string; name: string | null; orders: number; visits: number; gross: number }[]
}
type RefundsFacets = {
    totals: { amount: number; count: number }[]
    series: Bucketed<{ amount: number }>[]
    byReason: { _id: string | null; count: number; amount: number }[]
    byHour: { _id: number; count: number; amount: number }[]
    byTable: { _id: string; name: string | null; amount: number }[]
}

// Everything read from the orders paid in the range, in one pass. Read in the
// order paid (the index's own order, so no sort is made), so `$last` is the
// name and price diners saw last.
const ordersPipeline = (shopId: mongoose.Types.ObjectId, range: Range): PipelineStage[] => {
    const { start, end } = boundsOf(range)
    const bucket = bucketOf("$paidAt", range)
    const inZone = { date: "$paidAt", timezone: range.timeZone }
    return [
        { $match: { shopId, paidAt: { $gte: start, $lt: end } } },
        { $sort: { paidAt: 1 } },
        {
            $facet: {
                totals: summed(null),
                pending: [{ $match: { status: "pending" } }, { $count: "n" }],
                byProvider: [completed, { $group: { _id: "$provider", gross, orders: { $sum: 1 } } }],
                series: summed(bucket),
                seriesByProvider: [completed, { $group: { _id: { bucket, name: "$provider" }, gross } }],
                seriesByCategory: [completed, { $unwind: "$lines" }, { $group: { _id: { bucket, name: { $ifNull: ["$lines.category", "other"] } }, gross: { $sum: pence({ $multiply: ["$lines.qty", "$lines.unitPrice"] }) } } }],
                // Each diner's first bucket in the range (the keys sort as dates).
                payers: [completed, { $group: { _id: { payer: "$payerId", bucket } } }, { $group: { _id: "$_id.payer", first: { $min: "$_id.bucket" } } }],
                heatmap: [completed, { $group: { _id: { dow: { $isoDayOfWeek: inZone }, hour: { $hour: inZone } }, orders: { $sum: 1 }, gross } }],
                items: [completed, { $unwind: "$lines" },
                    { $group: { _id: "$lines.menuId", name: { $last: "$lines.name" }, category: { $last: "$lines.category" }, unitPrice: { $last: "$lines.unitPrice" }, units: { $sum: lineUnits }, refundedUnits: { $sum: "$lines.refundedQty" }, revenue: { $sum: pence({ $multiply: [lineUnits, "$lines.unitPrice"] }) } } },
                    { $sort: { revenue: -1, name: 1 } }],
                tables: [completed, { $group: { _id: "$tableId", name: { $last: "$tableName" }, orders: { $sum: 1 }, carts: { $addToSet: "$cartId" }, gross } },
                    { $project: { name: 1, orders: 1, gross: 1, visits: { $size: "$carts" } } }],
            },
        },
    ]
}

// The refunds made in the range, whenever their sale was.
const refundsPipeline = (shopId: mongoose.Types.ObjectId, range: Range): PipelineStage[] => {
    const { start, end } = boundsOf(range)
    const at = { $gte: start, $lt: end }
    const amount = { $sum: pence("$refunds.amount") }
    return [
        { $match: { shopId, "refunds.at": at } },
        { $unwind: "$refunds" },
        { $match: { "refunds.status": "completed", "refunds.at": at } },
        {
            $facet: {
                totals: [{ $group: { _id: null, amount, count: { $sum: 1 } } }],
                series: [{ $group: { _id: bucketOf("$refunds.at", range), amount } }],
                byReason: [{ $group: { _id: "$refunds.reason", count: { $sum: 1 }, amount } }, { $sort: { amount: -1, count: -1, _id: 1 } }],
                byHour: [{ $group: { _id: { $hour: { date: "$refunds.at", timezone: range.timeZone } }, count: { $sum: 1 }, amount } }, { $sort: { _id: 1 } }],
                byTable: [{ $group: { _id: "$tableId", name: { $last: "$tableName" }, amount } }],
            },
        },
    ]
}

const byKey = <T extends { _id: unknown }>(rows: T[]) => new Map(rows.map((row) => [String(row._id), row]))

// The report for one range. `previous` is the same for the range of the same
// length ending the day before, with what the comparison needs.
const report = async (shopId: mongoose.Types.ObjectId, range: Range) => {
    const { start } = boundsOf(range)
    const [[orders], [refunds]] = await Promise.all([
        OrderModel.aggregate<OrdersFacets>(ordersPipeline(shopId, range)),
        OrderModel.aggregate<RefundsFacets>(refundsPipeline(shopId, range)),
    ])
    // Who among the range's diners had paid here before it began.
    const payers = orders.payers.map((p) => p._id)
    const before = new Set((payers.length === 0 ? [] : await OrderModel.distinct("payerId", { shopId, payerId: { $in: payers }, status: "completed", paidAt: { $lt: start } })).map(String))

    const totals = orders.totals[0] ?? { gross: 0, orders: 0, visits: 0, diners: 0, units: 0 }
    const refunded = refunds.totals[0] ?? { amount: 0, count: 0 }
    const byProvider = byKey(orders.byProvider)
    const seriesRows = byKey(orders.series)
    const refundRows = byKey(refunds.series)
    const newDiners = new Map<string, number>()
    for (const payer of orders.payers) {
        if (!before.has(String(payer._id))) newDiners.set(payer.first, (newDiners.get(payer.first) ?? 0) + 1)
    }
    // gross per bucket per provider (or category): bucket -> name -> pence.
    const perBucket = (rows: { _id: { bucket: string; name: string }; gross: number }[]) => {
        const map = new Map<string, Map<string, number>>()
        for (const row of rows) map.set(row._id.bucket, (map.get(row._id.bucket) ?? new Map()).set(row._id.name, row.gross))
        return map
    }
    const providerBuckets = perBucket(orders.seriesByProvider)
    const categoryBuckets = perBucket(orders.seriesByCategory)
    const pounds = (p: number | undefined) => fromPence(p ?? 0)
    const split = (names: readonly string[], values: Map<string, number> | undefined) => Object.fromEntries(names.map((n) => [n, pounds(values?.get(n))]))

    const series = bucketsOf(range.from, range.to, range.by).map((bucket) => {
        const row = seriesRows.get(bucket)
        const gross = row?.gross ?? 0
        const refundsMade = refundRows.get(bucket)?.amount ?? 0
        return {
            bucket,
            gross: pounds(gross), refunds: pounds(refundsMade), net: pounds(gross - refundsMade),
            orders: row?.orders ?? 0, visits: row?.visits ?? 0, diners: row?.diners ?? 0, newDiners: newDiners.get(bucket) ?? 0, units: row?.units ?? 0,
            byCategory: split(["food", "drinks", "other"], categoryBuckets.get(bucket)),
            byProvider: split(PAYMENT_PROVIDERS, providerBuckets.get(bucket)),
        }
    })
    const refundsByTable = byKey(refunds.byTable)
    const tablesSold = new Set(orders.tables.map((t) => t._id))

    return {
        range: { ...range, days: daysBetween(range.from, range.to) },
        totals: {
            gross: pounds(totals.gross), refunds: pounds(refunded.amount), net: pounds(totals.gross - refunded.amount),
            orders: totals.orders, pendingOrders: orders.pending[0]?.n ?? 0, visits: totals.visits,
            diners: totals.diners, returningDiners: before.size, units: totals.units,
            byProvider: Object.fromEntries(PAYMENT_PROVIDERS.map((p) => [p, { gross: pounds(byProvider.get(p)?.gross), orders: byProvider.get(p)?.orders ?? 0 }])),
        },
        series,
        heatmap: orders.heatmap
            .map((cell) => ({ dow: cell._id.dow, hour: cell._id.hour, orders: cell.orders, gross: pounds(cell.gross) }))
            .sort((a, b) => a.dow - b.dow || a.hour - b.hour),
        items: orders.items.map((item) => ({
            menuId: item._id, name: item.name, category: item.category ?? null, unitPrice: item.unitPrice,
            units: item.units, refundedUnits: item.refundedUnits, revenue: pounds(item.revenue),
        })),
        refunds: {
            count: refunded.count,
            byReason: refunds.byReason.map((r) => ({ reason: r._id ?? null, count: r.count, amount: pounds(r.amount) })),
            byHour: refunds.byHour.map((h) => ({ hour: h._id, count: h.count, amount: pounds(h.amount) })),
        },
        // A table with only refunds in the range (its sales were before it) is
        // listed too, so the tables add up to the totals.
        tables: [...orders.tables, ...refunds.byTable.filter((t) => !tablesSold.has(t._id)).map((t) => ({ _id: t._id, name: t.name, orders: 0, visits: 0, gross: 0 }))]
            .map((t) => {
                const made = refundsByTable.get(t._id)?.amount ?? 0
                return { tableId: t._id, name: t.name ?? null, orders: t.orders, visits: t.visits, gross: pounds(t.gross), refunds: pounds(made), net: pounds(t.gross - made) }
            })
            .sort((a, b) => b.net - a.net || a.orders - b.orders),
    }
}

// GET /shops/:shopId/sales (the shop's manager, after isShopManager). The
// range is inclusive, in the shop's days; `compare=previous` adds the range of
// the same length ending the day before, bucketed the same way.
export const getSales: TController = async (req, res, next) => {
    try {
        const { from, to, by, compare } = res.locals.query as SalesQuery
        const shop = await ShopModel.findById(req.params.shopId).select("timeZone")
        if (!shop) return next(createError(404, "Shop Not Found!"))
        const shopId = shop._id as mongoose.Types.ObjectId
        const range: Range = { from, to, timeZone: shop.timeZone, by: by ?? groupBy(from, to) }

        const previousTo = addDays(from, -1)
        const previousFrom = addDays(previousTo, 1 - daysBetween(from, to))
        const [current, previous] = await Promise.all([
            report(shopId, range),
            compare ? report(shopId, { ...range, from: previousFrom, to: previousTo }) : null,
        ])
        if (!previous) return void res.send(current)
        res.send({ ...current, previous: { range: previous.range, totals: previous.totals, series: previous.series } })
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

// A CSV cell. Numbers as they are; text quoted when it holds a comma, a quote
// or a line break, and never left to start with = + - @ or a tab, which a
// spreadsheet would run as a formula: those get a leading apostrophe.
const cell = (value: string | number | null | undefined) => {
    if (typeof value === "number") return String(value)
    let text = value ?? ""
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
// UTF-8 with a byte-order mark (so Excel reads the pound sign and accents),
// CRLF line ends (RFC 4180).
const csv = (rows: (string | number | null | undefined)[][]) => "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
const PROVIDER_NAMES: Record<string, string> = { paypal: "PayPal", stripe: "Card" }
// For a file name: letters and digits, dashes between.
const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "shop"

// The orders' table: a row per payment made in the range, completed or still
// pending (failed ones are not sales), oldest first. `Refunded` is what has
// been given back of that payment to date, whenever the refund was made, so
// the rows don't add up to the report's refunds by day, which count refunds by
// their own day. No diner is named.
const ordersTable = async (shopId: mongoose.Types.ObjectId, range: Range) => {
    const { start, end } = boundsOf(range)
    const { timeZone } = range
    const orders = await OrderModel.find({ shopId, paidAt: { $gte: start, $lt: end }, status: { $in: ["completed", "pending"] } })
        .sort({ paidAt: 1 }).select("paidAt tableName provider status amount refunds lines").lean()
    return [
        ["Paid at", "Table", "Provider", "Status", "Amount", "Refunded", "Net", "Items"],
        ...orders.map((o) => {
            const refunded = o.refunds.filter((r) => r.status === "completed").reduce((sum, r) => sum + toPence(r.amount), 0)
            return [clockIn(o.paidAt, timeZone), o.tableName ?? "", PROVIDER_NAMES[o.provider] ?? o.provider, o.status,
                o.amount, fromPence(refunded), fromPence(toPence(o.amount) - refunded), o.lines.map((l) => `${l.qty}× ${l.name}`).join(", ")]
        }),
    ]
}

// GET /shops/:shopId/sales/export: one of the report's tables as a CSV file,
// counted as the report counts.
export const exportSales: TController = async (req, res, next) => {
    try {
        const { from, to, table } = res.locals.query as SalesExportQuery
        const shop = await ShopModel.findById(req.params.shopId).select("name timeZone")
        if (!shop) return next(createError(404, "Shop Not Found!"))
        const shopId = shop._id as mongoose.Types.ObjectId
        const range: Range = { from, to, timeZone: shop.timeZone, by: "day" }

        let rows: (string | number | null)[][]
        if (table === "orders") {
            rows = await ordersTable(shopId, range)
        } else if (table === "items") {
            rows = [["Item", "Category", "Unit price", "Units", "Refunded units", "Revenue"],
                ...(await report(shopId, range)).items.map((i) => [i.name, i.category ?? "", i.unitPrice, i.units, i.refundedUnits, i.revenue])]
        } else {
            rows = [["Day", "Gross", "Refunds", "Net", "Orders", "Visits", "Diners", "New diners", "Units", "Food", "Drinks", "Other", "PayPal", "Card"],
                ...(await report(shopId, range)).series.map((d) => [d.bucket, d.gross, d.refunds, d.net, d.orders, d.visits, d.diners, d.newDiners, d.units,
                    d.byCategory.food, d.byCategory.drinks, d.byCategory.other, d.byProvider.paypal, d.byProvider.stripe])]
        }
        res.attachment(`${slug(shop.name)}-sales-${from}-${to}-${table}.csv`)
        res.type("text/csv; charset=utf-8").send(csv(rows))
    } catch (error) {
        next(createError(500, error as Error))
    }
}
