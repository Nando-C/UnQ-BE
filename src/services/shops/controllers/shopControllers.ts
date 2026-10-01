import { TController } from "../../../typings/controllers"
import { IUserDocument } from "src/typings/users"
import { IDeletedTable } from "src/typings/shop"
import ShopModel from "../model"
import createError from "http-errors"
import CartModel, { AWAITING_PAYPAL } from "../../carts/model"
import MenuModel from "../../menus/model"
import { destroyReplacedImage, discardUpload } from "../../../settings/cloudinary"

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

        // A deleted table with something left to do (an open cart, or money
        // PayPal hasn't confirmed) is flagged `needsAttention`, so the manager's
        // page keeps listing it until that's done.
        const deletedIds = myShops.flatMap((shop) => shop.deletedTables.map((t) => String(t._id)))
        const needing = new Set(
            deletedIds.length === 0
                ? []
                : await CartModel.distinct("tableId", { tableId: { $in: deletedIds }, $or: [{ status: "open" }, AWAITING_PAYPAL] })
        )
        res.send(myShops.map((shop) => {
            const json = shop.toJSON()
            return {
                ...json,
                deletedTables: json.deletedTables.map((t: IDeletedTable) =>
                    needing.has(String(t._id)) ? { ...t, needsAttention: true } : t),
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
        // and its carts, by the shop they record or, for older ones, their table.
        // So it waits for any money still in flight: a table with an open cart,
        // and a payment or refund PayPal hasn't confirmed, which a manager can
        // only settle from this shop's pages.
        const shop = await ShopModel.findOne({_id: shopId, shopMg: user._id }).select("tables deletedTables")
        const itsCarts = shop && {
            $or: [
                { shopId: shop._id },
                { tableId: { $in: [...shop.tables, ...shop.deletedTables].map((t) => String(t._id)) } },
            ],
        }
        if (itsCarts && await CartModel.exists({ $and: [itsCarts, { status: "open" }] })) {
            return next(createError(409, "A table in this shop has an open cart — close it first"))
        }
        const awaiting = itsCarts && await CartModel.findOne({ $and: [itsCarts, AWAITING_PAYPAL] }).select("tableId")
        if (shop && awaiting) {
            const table = [...shop.tables, ...shop.deletedTables].find((t) => String(t._id) === awaiting.tableId)
            return next(createError(409, `A payment or refund at table ${table?.name ?? "(unknown)"} is still awaiting PayPal — check it there first`))
        }

        const deletedShop = await ShopModel.findOneAndDelete({_id: shopId, shopMg: user._id })
        if (!deletedShop || !itsCarts) return next(createError(400, "Shop Not Found or you are not authorized!"))

        await Promise.all([
            MenuModel.deleteMany({ $or: [{ _id: { $in: deletedShop.menu } }, { deletedFrom: deletedShop._id }] }),
            CartModel.deleteMany(itsCarts),
        ])

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