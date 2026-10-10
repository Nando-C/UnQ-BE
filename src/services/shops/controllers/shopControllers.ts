import { TController } from "../../../typings/controllers"
import { IUserDocument } from "src/typings/users"
import { IDeletedTable } from "src/typings/shop"
import ShopModel from "../model"
import createError from "http-errors"
import CartModel, { AWAITING_PROVIDER, RECENTLY_CLOSED_MS } from "../../carts/model"
import { awaitedProvider } from "../../../lib/payments"
import MenuModel from "../../menus/model"
import { keepShopOrders } from "../../orders/sync"
import { cardMoneyHolding } from "../../carts/stripeDeletion"
import PaybackModel from "../../payments/payback"
import { destroyReplacedImage, discardUpload } from "../../../settings/cloudinary"
import mongoose, { PipelineStage } from "mongoose"
import { BrowseShopsQuery } from "../schemas"

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
        if (!shop) return next(createError(400, "Shop Not Found or you are not authorized!"))
        const allTables = [...shop.tables, ...shop.deletedTables]
        const tableIds = allTables.map((t) => String(t._id))
        // Its carts, and its card payments' records: by the shop they record
        // or, for older ones, their table.
        const itsCarts = { $or: [{ shopId: shop._id }, { tableId: { $in: tableIds } }] }
        if (await CartModel.exists({ $and: [itsCarts, { status: "open" }] })) {
            return next(createError(409, "A table in this shop has an open cart — close it first"))
        }
        const tableName = (tableId: string) => allTables.find((t) => String(t._id) === tableId)?.name ?? "(unknown)"
        const awaiting = await CartModel.findOne({ $and: [itsCarts, AWAITING_PROVIDER] }).select("tableId payments refunds")
        if (awaiting) {
            return next(createError(409, `A payment or refund at table ${tableName(awaiting.tableId)} is still awaiting ${awaitedProvider(awaiting)} — check it there first`))
        }
        // Card payments (S35): one still being finished, a diner to pay back,
        // a card refund that can still fail (stripeDeletion.ts).
        const holding = await cardMoneyHolding(shop._id, itsCarts, tableIds, tableName)
        if (holding) return next(createError(409, holding))
        const since = new Date(Date.now() - RECENTLY_CLOSED_MS)
        const onSheets = await CartModel.find({ $and: [itsCarts, { status: "closed", updatedAt: { $gte: since }, "payments.0": { $exists: true } }] })
            .select("tableId payments")
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
        try {
            await keepShopOrders(itsCarts, shop)
        } catch (error) {
            console.error("Shop not deleted: its sales records couldn't be written", { shopId, error })
            return next(createError(500, "The shop's sales records couldn't be saved, so nothing was deleted. Try again shortly.", { expose: true }))
        }

        const deletedShop = await ShopModel.findOneAndDelete({_id: shopId, shopMg: user._id })
        if (!deletedShop) return next(createError(400, "Shop Not Found or you are not authorized!"))

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