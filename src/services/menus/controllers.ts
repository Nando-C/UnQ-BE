import { TController } from "src/typings/controllers"
import MenuModel from "./model"
import ShopModel from "../shops/model"
import createError from "http-errors"
import { destroyReplacedImage, discardUpload } from "../../settings/cloudinary"

// -------------------------------------------------------------------------

// Route guard: the item must be on this shop's menu. isShopManager only checks
// the shop in the URL, so without this a manager of one shop could read or edit
// another shop's items by id. On the image route it runs before the upload.
export const isOnShopMenu: TController = async ( req, res, next ) => {
    try {
        const onMenu = await ShopModel.exists({ _id: req.params.shopId, menu: req.params.itemId })
        if (!onMenu) return next(createError(404, "Menu Item Not Found!"))
        next()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

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

        // Deleted while the image was uploading.
        const previous = await MenuModel.findById(itemId).select("image")
        if (!previous) {
            discardUpload(req)
            return next(createError(404, "Menu Item Not Found!"))
        }

        const modifiedItem = await MenuModel.findByIdAndUpdate(itemId, { image: req.file?.path}, { runValidators: true })
        if (!modifiedItem) {
            discardUpload(req)
            return next(createError(404, "Menu Item Not Found!"))
        }

        destroyReplacedImage(previous.image)
        res.send(modifiedItem)
    } catch (error) {
        discardUpload(req)
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