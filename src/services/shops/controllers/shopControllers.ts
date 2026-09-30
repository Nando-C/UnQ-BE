import { TController } from "../../../typings/controllers"
import { IUserDocument } from "src/typings/users"
import ShopModel from "../model"
import createError from "http-errors"
import CartModel from "../../carts/model"
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

        res.send(myShops)
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
        if (itsCarts && await CartModel.exists({ $and: [itsCarts, { $or: [{ "payments.status": "pending" }, { "refunds.status": "pending" }] }] })) {
            return next(createError(409, "A payment or refund in this shop is still awaiting PayPal — check it first"))
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