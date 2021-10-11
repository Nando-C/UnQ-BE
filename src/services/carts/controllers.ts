import { TController } from "src/typings/controllers"
import { IUserDocument } from "src/typings/users"
import CartModel from "./model"
import createError from "http-errors"
// import { Schema } from "mongoose"


export const getMyCarts: TController = async ( req, res, next) => {
    try {
        const user = req.user as IUserDocument

        const myCarts = await CartModel.find({ userId: user._id })
            .populate("items.menuId", "name short_description image price")
            .populate("split.menuId", "name short_description image price")
            
        if (!myCarts) return next(createError(404, "Carts Not Found!"))

        res.send(myCarts)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

export const getTableCart: TController = async ( req, res, next ) => {
    try {
        const tableId = req.params.tableId

        const cart = await CartModel.findOne({ tableId: tableId, status: "open"})
            .populate("items.menuId", "name short_description image price")
            .populate("split.menuId", "name short_description image price")

        if (!cart) return next(createError(404, `Cart Not Found!`))
        
        res.send(cart)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

export const getSingleCart: TController = async ( req, res, next ) => {
    try {
        const cart = await CartModel.findById(req.params.cartId)
            .populate("items.menuId", "name short_description image price")
            .populate("split.menuId", "name short_description image price")

        if (!cart) return next(createError(404, `Cart Not Found!`))
        
        res.send(cart)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

export const addItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        // const shopId = req.params.shopId as Schema.Types.ObjectId
        const tableId = req.params.tableId
        const item = req.body

        const isItemThere = await CartModel.findOne({userId: user._id, tableId: tableId, status: "open", "items.menuId": item.menuId})
        
        if (isItemThere) {
            const updatedItem = await CartModel.findOneAndUpdate({userId: user._id, tableId: tableId, status: "open", "items.menuId": item.menuId}, { $inc: { "items.$.qty": req.body.qty }}).populate("items.menuId", "name short_description image price")
            res.send(updatedItem)
        } else {
            const addedItem = await CartModel.findOneAndUpdate({userId: user._id, tableId: tableId, status: "open"}, { $push: { items: item }}, { upsert: true })
            res.send(addedItem)
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}

export const decreaseItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        // const shopId = req.params.shopId as Schema.Types.ObjectId
        const tableId = req.params.tableId
        const item = req.body

        const isItemThere = await CartModel.findOne({userId: user._id, tableId: tableId, status: "open", "items.menuId": item.menuId})
        
        if (isItemThere) {
            const decreasedItem = await CartModel.findOneAndUpdate({userId: user._id, tableId: tableId, status: "open", "items.menuId": item.menuId}, { $inc: { "items.$.qty": -(req.body.qty) }}).populate("items.menuId", "name short_description image price")
            
            const removedItem = await CartModel.findOneAndUpdate({userId: user._id, tableId: tableId, status: "open", "items.menuId": item.menuId}, { $pull: { items: { qty: 0 }}}).populate("items.menuId", "name short_description image price")
            
            const deleteCart = await CartModel.findOneAndDelete({userId: user._id, tableId: tableId, status: "open", items: []}).populate("items.menuId", "name short_description image price")
            
            if (deleteCart) {
                res.status(204).send()
            } else if (removedItem) {
                res.send(removedItem)
            } else {
                res.send(decreasedItem)
            }

        } else {
            res.status(404).send("Item Not Found in Cart!")
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}

export const addSplitItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId
        console.log(cartId);
        
        
        const splitItem = {
            userId: user._id,
            ...req.body
        }

        // const isItemThere = await CartModel.findOne({ _id: cartId, "split.splitStatus": "open", "split.userId": user._id, "split.menuId": splitItem.menuId })
        const isItemThere = await CartModel.findOne({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } })
        console.log(isItemThere)
        
        if (isItemThere) {
            // const selectedCart = await CartModel.findById(cartId)
            const updatedSplit = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $inc: { "split.$.qty": 1 }})
            // const updatedSplit = await CartModel.findOneAndUpdate({_id: cartId}, { $inc: { "split.$[i].qty": 1 }}, {arrayFilters: [{"i": { $elemMatch: {userId: user._id, menuId: splitItem.menuId }} }]} )
            res.send(updatedSplit)

        } else {
            const addedItem = await CartModel.findOneAndUpdate({ _id: cartId, status: "open" }, { $push: { split: splitItem }})
            res.send(addedItem)
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}

export const removeSplitItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId

        const splitItem = {
            userId: user._id,
            ...req.body
        }

        // const isItemThere = await CartModel.findOne({ _id: cartId, "split.splitStatus": "open", "split.userId": user._id, "split.menuId": splitItem.menuId })
        const isItemThere = await CartModel.findOne({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } })

        if (isItemThere) {
            // const decreasedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: { menuId: splitItem.menuId , userId: user._id} } }, { $inc: { "split.$.qty": -(1) }})
            const decreasedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $inc: { "split.$.qty": -(1) }})
            
            const removedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $pull: { split: { qty: 0 }}})
            
            if (removedItem) {
                res.send(removedItem)
            } else {
                res.send(decreasedItem)
            }
        } else {
            res.status(404).send("Item Not Found!")
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}