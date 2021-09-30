import { TController } from "../../../typings/controllers"
import { IUserDocument } from "src/typings/users"
import ShopModel from "../model"
import createError from "http-errors"

// -------------------------------------------------------------------------

export const createItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const shopId = req.params.shopId
        const newItem = req.body

        const updatedShopMenu = await ShopModel.findOneAndUpdate({_id: shopId, shopMg: user._id }, { $push: {menu: newItem}}, { runValidators: true})
        if (!updatedShopMenu) return next(createError(400, "Shop Not Found or you are not authorized!"))

        res.send(updatedShopMenu.menu)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const getMenuList: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const shopId = req.params.shopId

        const shopMenuList = await ShopModel.findById({_id: shopId, shopMg: user._id })
        if (!shopMenuList) return next(createError(400, "Shop Not Found or you are not authorized!"))

        res.send(shopMenuList.menu)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const getMenuItem: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId
        const itemId = req.params.itemId

        const menuItem = await ShopModel.findById(shopId, { menu: { $elemMatch: {_id: itemId}} } )
        if (!menuItem) return next(createError(400, "Shop Not Found or you are not authorized!"))

        res.send(menuItem.menu[0])
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const editItem: TController = async ( req, res, next ) => {
    try {
        // const user = req.user as IUserDocument
        const shopId = req.params.shopId
        const itemId = req.params.itemId
        const modification = req.body

        const modifiedShop = await ShopModel.findOneAndUpdate(
            { _id: shopId, menu: { $elemMatch: {_id: itemId} } },
            { $set: { "menu.$": modification } },
            { runValidators: true }
        )
        if (!modifiedShop) return next(createError(404, "Menu Item Not Found!"))
        res.send(modifiedShop.menu)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const deleteItem: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId
        const itemId = req.params.itemId

        const modifiedShop = await ShopModel.findByIdAndUpdate(shopId, { $pull: { menu: { _id: itemId} } })
        if (!modifiedShop) return next(createError(404, "Menu Item Not Found!"))

        res.status(204).send()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const editItemImage: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId
        const itemId = req.params.itemId

        const modifiedShop = await ShopModel.findOneAndUpdate( 
            { _id: shopId, "menu._id": itemId },
            { $set: { "menu.$.image": req.file?.path } },
            { runValidators: true } 
        )
        if (!modifiedShop) return next(createError(404, "Menu Item Not Found!"))

        res.send(modifiedShop.menu)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------