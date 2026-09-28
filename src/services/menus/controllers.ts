import { TController } from "src/typings/controllers"
import MenuModel from "./model"
import ShopModel from "../shops/model"
import createError from "http-errors"

// -------------------------------------------------------------------------

// Whether the item is on this shop's menu. isShopManager only checks the shop in
// the URL, so without this a manager of one shop could read, edit or delete
// another shop's items by id.
const onShopMenu = (shopId: string, itemId: string) => ShopModel.exists({ _id: shopId, menu: itemId })

// -------------------------------------------------------------------------

export const createItem: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId
        const newItem = await new MenuModel(req.body).save()

        const updatedShopMenu = await ShopModel.findByIdAndUpdate(shopId , { $push: {menu: newItem._id}}, { runValidators: true})
        if (!updatedShopMenu) return next(createError(404, "Shop Not Found!"))

        res.send(newItem)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const getMenuList: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId

        const shopMenuList = await ShopModel.findById(shopId).populate("menu")
        if (!shopMenuList) return next(createError(404, "Shop Not Found!"))

        res.send(shopMenuList.menu)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const getMenuItem: TController = async ( req, res, next ) => {
    try {
        const itemId = req.params.itemId

        if (!(await onShopMenu(req.params.shopId, itemId))) return next(createError(404, "Menu Item Not Found!"))

        const menuItem = await MenuModel.findById(itemId)
        if (!menuItem) return next(createError(404, "Menu Item Not Found!"))

        res.send(menuItem)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const editItem: TController = async ( req, res, next ) => {
    try {
        const itemId = req.params.itemId

        if (!(await onShopMenu(req.params.shopId, itemId))) return next(createError(404, "Menu Item Not Found!"))

        const modifiedItem = await MenuModel.findByIdAndUpdate(itemId, req.body, { runValidators: true })
        if (!modifiedItem) return next(createError(404, "Menu Item Not Found!"))

        res.send(modifiedItem)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const editItemImage: TController = async ( req, res, next ) => {
    try {
        const itemId = req.params.itemId

        if (!(await onShopMenu(req.params.shopId, itemId))) return next(createError(404, "Menu Item Not Found!"))

        const modifiedItem = await MenuModel.findByIdAndUpdate(itemId, { image: req.file?.path}, { runValidators: true })
        if (!modifiedItem) return next(createError(404, "Menu Item Not Found!"))

        res.send(modifiedItem)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const deleteItem: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId
        const itemId = req.params.itemId

        // Only pulls (and then deletes) an item that is on this shop's menu.
        const updatedShopMenu = await ShopModel.findOneAndUpdate({ _id: shopId, menu: itemId }, { $pull: {menu: itemId}}, { runValidators: true})
        if (!updatedShopMenu) return next(createError(404, "Menu Item Not Found!"))

        const deletedItem = await MenuModel.findByIdAndDelete(itemId)
        if (!deletedItem) return next(createError(404, "Menu Item Not Found!"))

        res.status(204).send()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------