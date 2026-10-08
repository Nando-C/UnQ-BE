import { TController } from "../../../typings/controllers"
import { IUserDocument } from "src/typings/users"
import { IDeletedTable } from "src/typings/shop"
import ShopModel from "../model"
import createError from "http-errors"
import CartModel, { AWAITING_PROVIDER, RECENTLY_CLOSED_MS } from "../../carts/model"
import { awaitedProvider } from "../../../lib/payments"
import MenuModel from "../../menus/model"
import { keepShopOrders, SHOP_DELETION_READ } from "../../orders/sync"
import StripeCheckoutModel, { CHECKOUT_STATES, FINAL_STATES } from "../../carts/stripeCheckout"
import PaybackModel from "../../payments/payback"
import { destroyReplacedImage, discardUpload } from "../../../settings/cloudinary"
import mongoose, { PipelineStage } from "mongoose"
import { BrowseShopsQuery } from "../schemas"

// How long after a card refund last moved Stripe may still report it failed
// (S35's shop deletion waits that long).
const CARD_REFUND_CAN_FAIL_MS = 30 * 24 * 60 * 60 * 1000
// A card payment's states while it's being finished (stripeCheckout.ts): not
// `open` (one nobody confirmed holds nothing, and is cancelled in an hour; one
// confirmed meanwhile is released, its cart gone).
const UNFINISHED = CHECKOUT_STATES.filter((state) => state !== "open" && !FINAL_STATES.includes(state))
const dateOf = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })

// The text as a pattern that matches it literally.
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// -------------------------------------------------------------------------

export const createShop: TController = async ( req, res, next ) => {
    try {
    const user = req.user as IUserDocument

    const newShop = { 
        ...req.body, 
        shopMg: [ user._id ],
    }

        const shop = await new ShopModel(newShop).save()
        res.send(shop)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const getMyShops: TController = async ( req, res, next) => {
    try {
        const user = req.user as IUserDocument

        const myShops = await ShopModel.find({ shopMg: user._id }).populate("menu")
        if (!myShops) return next(createError(404, "Shops Not Found!"))

        // The manager's page lists a deleted table while its sheet has something
        // on it: `needsAttention` when there's something left to do (an open
        // cart, money a provider hasn't confirmed, or a diner to pay back), and until `recentCartsUntil`
        // while it shows a closed cart (refundable there): a day after the
        // latest one last changed.
        const deletedIds = myShops.flatMap((shop) => shop.deletedTables.map((t) => String(t._id)))
        const since = new Date(Date.now() - RECENTLY_CLOSED_MS)
        const [needingIds, owedIds, latest] = deletedIds.length === 0
            ? [[], [], []]
            : await Promise.all([
                CartModel.distinct("tableId", { tableId: { $in: deletedIds }, $or: [{ status: "open" }, AWAITING_PROVIDER] }),
                PaybackModel.distinct("tableId", { tableId: { $in: deletedIds }, owed: true }),
                CartModel.aggregate<{ _id: string; last: Date }>([
                    { $match: { tableId: { $in: deletedIds }, status: "closed", updatedAt: { $gte: since } } },
                    { $group: { _id: "$tableId", last: { $max: "$updatedAt" } } },
                ]),
            ])
        const needing = new Set([...needingIds, ...owedIds])
        const recentUntil = new Map(latest.map((t) => [t._id, new Date(t.last.getTime() + RECENTLY_CLOSED_MS)]))
        res.send(myShops.map((shop) => {
            const json = shop.toJSON()
            return {
                ...json,
                deletedTables: json.deletedTables.map((t: IDeletedTable) => ({
                    ...t,
                    ...(needing.has(String(t._id)) && { needsAttention: true }),
                    ...(recentUntil.has(String(t._id)) && { recentCartsUntil: recentUntil.get(String(t._id)) }),
                })),
            }
        }))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const getAllShops: TController = async ( req, res, next) => {
    try {
        // Deleted tables are the manager's alone (GET /shops/me).
        const shopList = await ShopModel.find().select("-deletedTables").populate("menu")
        if (!shopList) return next(createError(404, "Shops Not Found!"))

        res.send(shopList)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

// browseShops' search (what `q` matches is described there). One menu item
// named with it is enough; a deleted item has already left its shop's menu.
const searchStages = (q: string): PipelineStage[] => {
    const text = new RegExp(escapeRegExp(q), "i")
    return [
        {
            $lookup: {
                from: MenuModel.collection.name,
                localField: "menu",
                foreignField: "_id",
                pipeline: [{ $match: { name: text } }, { $limit: 1 }, { $project: { _id: 1 } }],
                as: "itemsNamed",
            },
        },
        { $match: { $or: [{ name: text }, { bio: text }, { "itemsNamed.0": { $exists: true } }] } },
    ]
}

// browseShops' query: `limit + 1` shops, to tell whether there's a next page.
export const browsePipeline = (q: string, cursor: string | undefined, limit: number): PipelineStage[] => [
    { $match: cursor ? { _id: { $gt: new mongoose.Types.ObjectId(cursor) } } : {} },
    { $sort: { _id: 1 } },
    ...(q ? searchStages(q) : []),
    { $limit: limit + 1 },
    { $project: { name: 1, bio: 1, cover: 1 } },
]

// The home page's list: a page of shops, without their menus or tables, oldest
// first; `next` is the cursor for the page after (null on the last). With `q`,
// only shops whose name or bio holds it, or whose menu has an item named with
// it, case aside (what the home page used to match in the browser). Unanchored
// patterns can't use an index, so a search reads shops in `_id` order, each
// with its own menu items (by `_id`), until the page is full.
export const browseShops: TController = async ( req, res, next) => {
    try {
        const { q, cursor, limit } = res.locals.query as BrowseShopsQuery

        const found = await ShopModel.aggregate(browsePipeline(q, cursor, limit))

        // Through the model, so the cover's default fills in as on the other routes.
        const shops = found.slice(0, limit).map((stored) => {
            const { _id, name, bio, cover } = ShopModel.hydrate(stored)
            return { _id, name, bio, cover }
        })
        res.send({ shops, next: found.length > limit ? shops[shops.length - 1]._id : null })
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const getSingleShop: TController = async ( req, res, next ) => {
    try {
        const myShop = await ShopModel.findById(req.params.shopId).select("-deletedTables").populate("menu")

        if (myShop) {
            res.send(myShop)
        } else {
            next(createError(404, `Shop Not Found!`))
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const editMyShop: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const shopId = req.params.shopId

        const modifiedShop = await ShopModel.findOneAndUpdate({_id: shopId, shopMg: user._id }, req.body, {runValidators: true })
        if (!modifiedShop) return next(createError(400, "Shop Not Found or you are not authorized!"))

        res.send(modifiedShop)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const deleteMyShop: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const shopId = req.params.shopId

        // The shop goes with everything in it: its menu items (deleted ones too)
        // and its carts, by the shop they record or, for older ones, their table,
        // payment records included. So it waits for any money still in flight
        // (a table with an open cart, a payment or refund its provider hasn't
        // confirmed), which a manager can only settle from this shop's pages,
        // and while a payment with something left to refund is on its table's
        // sheet (a cart closed or changed in the last 24 hours).
        const shop = await ShopModel.findOne({_id: shopId, shopMg: user._id }).select("tables deletedTables")
        const allTables = shop ? [...shop.tables, ...shop.deletedTables] : []
        const tableIds = allTables.map((t) => String(t._id))
        // Its carts, and its card payments' records: by the shop they record
        // or, for older ones, their table.
        const itsCarts = shop && { $or: [{ shopId: shop._id }, { tableId: { $in: tableIds } }] }
        if (itsCarts && await CartModel.exists({ $and: [itsCarts, { status: "open" }] })) {
            return next(createError(409, "A table in this shop has an open cart — close it first"))
        }
        const tableName = (tableId: string) => allTables.find((t) => String(t._id) === tableId)?.name ?? "(unknown)"
        const awaiting = itsCarts && await CartModel.findOne({ $and: [itsCarts, AWAITING_PROVIDER] }).select("tableId payments refunds")
        if (awaiting) {
            return next(createError(409, `A payment or refund at table ${tableName(awaiting.tableId)} is still awaiting ${awaitedProvider(awaiting)} — check it there first`))
        }
        // Card payments (S35): one still being finished may yet be handed to
        // staff, and a card refund can fail at Stripe long after it was made
        // (even after Stripe said it succeeded): its pay-back then needs the
        // shop to be seen on. So the shop waits for those, for any diner still
        // to be paid back (what the manager can do now), and for 30 days after
        // a card refund last moved.
        if (shop && itsCarts) {
            // The refunds Stripe still calls succeeded: the API's own (records
            // `refunded`; one that failed is handed over, and done with above)
            // by when they last moved, and the managers' by when they were
            // made, on the carts changed since the cutoff (a refund's change is
            // one), a card payment's and without a pay-back (failed already).
            const cutoff = new Date(Date.now() - CARD_REFUND_CAN_FAIL_MS)
            const latestRecord = (by: object) => StripeCheckoutModel
                .findOne({ refunding: true, state: "refunded", updatedAt: { $gte: cutoff }, ...by })
                .sort({ updatedAt: -1 }).select("updatedAt").lean()
            const [finishing, owed, byShop, byTable, carts, failed] = await Promise.all([
                StripeCheckoutModel.findOne({
                    $and: [
                        { $or: [{ state: { $in: UNFINISHED } }, { state: "refundFailed", staffToldAt: { $exists: false } }] },
                        itsCarts,
                    ],
                }).select("tableId refunding").lean(),
                PaybackModel.findOne({ shopId: shop._id, owed: true }).select("tableId").lean(),
                latestRecord({ shopId: shop._id }),
                latestRecord({ tableId: { $in: tableIds } }),
                CartModel.find({ $and: [itsCarts, {
                    status: "closed", updatedAt: { $gte: cutoff }, "payments.provider": "stripe", "refunds.status": "completed",
                }] }).select("payments._id payments.provider refunds._id refunds.paymentId refunds.status refunds.at").comment(SHOP_DELETION_READ).lean(),
                PaybackModel.find({ shopId: shop._id, kind: "refundFailed", at: { $gte: cutoff } }).select("refundId").lean(),
            ])
            if (finishing) {
                // Refunding: Stripe refused it for now, and it's retried (stripeFinish.ts's refund()).
                return next(createError(409, finishing.refunding
                    ? `A card refund at Table ${tableName(finishing.tableId)} is being retried at Stripe (every 30 minutes, for up to a day) — try again later`
                    : `A card payment at Table ${tableName(finishing.tableId)} is still being finished — try again shortly`))
            }
            if (owed) {
                return next(createError(409, `A diner at Table ${tableName(owed.tableId)} is still to be paid back — mark it done first`))
            }
            const failedIds = new Set(failed.map((p) => String(p.refundId)))
            const cardRefunds = carts.flatMap((cart) => {
                const cards = new Set(cart.payments.filter((p) => p.provider === "stripe").map((p) => String(p._id)))
                return cart.refunds
                    .filter((r) => r.status === "completed" && cards.has(String(r.paymentId)) && !failedIds.has(String(r._id)))
                    .map((r) => r.at.getTime())
            })
            const lastRefund = Math.max(byShop?.updatedAt.getTime() ?? 0, byTable?.updatedAt.getTime() ?? 0,
                ...cardRefunds.filter((at) => at >= cutoff.getTime()))
            if (lastRefund) {
                return next(createError(409, `A card refund at this shop on ${dateOf(lastRefund)} can still fail at Stripe until ` +
                    `${dateOf(lastRefund + CARD_REFUND_CAN_FAIL_MS)}: the shop can be deleted from then`))
            }
        }
        const since = new Date(Date.now() - RECENTLY_CLOSED_MS)
        const onSheets = itsCarts
            ? await CartModel.find({ $and: [itsCarts, { status: "closed", updatedAt: { $gte: since }, "payments.0": { $exists: true } }] })
                .select("tableId payments")
            : []
        // As the sheet offers a refund: a completed payment (those from before
        // payments had a status read as completed) with its capture id and
        // something left to refund.
        const refundable = onSheets.find((cart) => cart.payments.some((p) =>
            p.status === "completed" && !!p.providerPaymentId && p.lines.some((l) => l.qty > l.refundedQty)))
        if (refundable) {
            return next(createError(409, `A payment at table ${tableName(refundable.tableId)} can still be refunded from its sheet: the shop can be deleted once no paid cart has changed for a day`))
        }

        // Its carts go with it, and the orders are then the only record of
        // their payments: any order missing or older than its cart (a sync
        // that failed earlier) is written first, or nothing is deleted. Reads
        // all its paid carts, as deleting them does.
        if (itsCarts) {
            try {
                await keepShopOrders(itsCarts, shop)
            } catch (error) {
                console.error("Shop not deleted: its sales records couldn't be written", { shopId, error })
                return next(createError(500, "The shop's sales records couldn't be saved, so nothing was deleted. Try again shortly.", { expose: true }))
            }
        }

        const deletedShop = await ShopModel.findOneAndDelete({_id: shopId, shopMg: user._id })
        if (!deletedShop || !itsCarts) return next(createError(400, "Shop Not Found or you are not authorized!"))

        await Promise.all([
            MenuModel.deleteMany({ $or: [{ _id: { $in: deletedShop.menu } }, { deletedFrom: deletedShop._id }] }),
            CartModel.deleteMany(itsCarts),
        ])
        // Its pay-backs go with it too. One written in the moment between the
        // checks and the delete has no shop left to be seen on: logged first.
        for (const late of await PaybackModel.find({ shopId: deletedShop._id, owed: true }).select("paymentIntentId amount userId").lean()) {
            console.error("A diner is still to be paid back, but their shop was just deleted: pay them back from Stripe's dashboard", {
                paybackId: String(late._id), paymentIntentId: late.paymentIntentId, amount: late.amount, userId: String(late.userId),
            })
        }
        await PaybackModel.deleteMany({ shopId: deletedShop._id })

        res.status(204).send()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const editMyShopCover: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const shopId = req.params.shopId

        const previous = await ShopModel.findById(shopId).select("cover")
        const shopWithNewCover = await ShopModel.findOneAndUpdate({_id: shopId, shopMg: user._id }, { cover: req.file?.path }, {runValidators: true })
        if (!shopWithNewCover) {
            discardUpload(req)
            return next(createError(400, "Shop Not Found or you are not authorized!"))
        }

        destroyReplacedImage(previous?.cover)
        res.send(shopWithNewCover)
    } catch (error) {
        discardUpload(req)
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------