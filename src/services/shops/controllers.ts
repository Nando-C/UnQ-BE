import { TController } from "src/typings/controllers"
import ShopModel from "./model"
import createError from "http-errors"
import { IUserDocument } from "src/typings/users"

export const createShop: TController = async ( req, res, next ) => {
    try {
    const user = req.user as IUserDocument

    const newShop = { 
        ...req.body, 
        shopMg: [ user._id ],
        cover: `https://nayemdevs.com/wp-content/uploads/2020/03/default-product-image.png`,
    }

        const shop = await new ShopModel(newShop).save()
        res.send(shop)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

export const getMyShops: TController = async ( req, res, next) => {
    try {
        const user = req.user as IUserDocument

        const myShops = await ShopModel.find({ shopMg: user._id })
        if (!myShops) return next(createError(404, "Shops Not Found!"))

        res.send(myShops)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

export const getMySingleShop: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument

        const myShop = await ShopModel.findById(req.params.shopId)

        if (myShop) {
            if ( myShop.shopMg.includes(user._id)){
                res.send(myShop)
            } else {
                next(createError(403, `Shop Manager Only!`))
            }
        } else {
            next(createError(404, `Shop Not Found!`))
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}

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

export const deleteMyShop: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const shopId = req.params.shopId

        const deletedShop = await ShopModel.findOneAndDelete({_id: shopId, shopMg: user._id })
        if (!deletedShop) return next(createError(400, "Shop Not Found or you are not authorized!"))

        res.status(204).send()
    } catch (error) {
        next(createError(500, error as Error))
    }
}