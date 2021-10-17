import { TController } from "src/typings/controllers"
import { IUserDocument } from "src/typings/users"
import CartModel from "./model"
import createError from "http-errors"
// import { Schema } from "mongoose"


export const getMyCarts: TController = async ( req, res, next) => {
    try {
        const user = req.user as IUserDocument

        const myCarts = await CartModel.findOne({ userId: user._id, status: "open" })
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

        const cart = await CartModel.findOne({$and: [{ tableId: tableId}, {status: "open"}]})
            .populate("items.menuId", "name short_description image price")
            .populate("split.menuId", "name short_description image price")
        console.log(cart)
        

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
        // console.log(item)
        

        const isItemThere = await CartModel.findOne({userId: user._id, tableId: tableId, status: "open", "items.menuId": item.menuId})
        
        if (isItemThere) {
            const updatedItem = await CartModel.findOneAndUpdate({userId: user._id, tableId: tableId, status: "open", "items.menuId": item.menuId}, { $inc: { "items.$.qty": req.body.qty }}).populate("items.menuId", "name short_description image price")
            res.send(updatedItem)
        } else {
            const addedItem = await CartModel.findOneAndUpdate({userId: user._id, tableId: tableId, status: "open"}, { $push: { items: item }}, { upsert: true }).populate("items.menuId", "name short_description image price")
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

export const deleteItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        // const shopId = req.params.shopId as Schema.Types.ObjectId
        const tableId = req.params.tableId
        const item = req.body

        const isItemThere = await CartModel.findOne({userId: user._id, tableId: tableId, status: "open", "items.menuId": item.menuId})
        
        if (isItemThere) {
            const decreasedItem = await CartModel.findOneAndUpdate({userId: user._id, tableId: tableId, status: "open", "items.menuId": item.menuId}, { $set: { "items.$.qty": 0 }}).populate("items.menuId", "name short_description image price")
            
            const removedItem = await CartModel.findOneAndUpdate({userId: user._id, tableId: tableId, status: "open", "items.menuId": item.menuId}, { $pull: { items: { qty: 0 }}}).populate("items.menuId", "name short_description image price")
            
            // const deleteCart = await CartModel.findOneAndDelete({userId: user._id, tableId: tableId, status: "open", items: []}).populate("items.menuId", "name short_description image price")
            
            // if (deleteCart) {
                // res.status(204).send()
            // } else 
            if (removedItem) {
                res.send(removedItem)
            } else {
                res.send(removedItem)
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
        console.log("splitItem: " ,splitItem)
        

        // const isItemThere = await CartModel.findOne({ _id: cartId, "split.splitStatus": "open", "split.userId": user._id, "split.menuId": splitItem.menuId })
        const isItemThere = await CartModel.findOne({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } })
        console.log(isItemThere)
        
        if (isItemThere) {
            // const selectedCart = await CartModel.findById(cartId)
            const updatedSplit = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $inc: { "split.$.qty": req.body.qty }}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")
            // const updatedSplit = await CartModel.findOneAndUpdate({_id: cartId}, { $inc: { "split.$[i].qty": 1 }}, {arrayFilters: [{"i": { $elemMatch: {userId: user._id, menuId: splitItem.menuId }} }]} )
            res.send(updatedSplit)

        } else {
            const addedItem = await CartModel.findOneAndUpdate({ _id: cartId, status: "open" }, { $push: { split: splitItem }}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")
            res.send(addedItem)
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}

export const decreaseSplitItem: TController = async ( req, res, next ) => {
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
            const decreasedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $inc: { "split.$.qty": -(1) }}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")
            
            const removedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $pull: { split: { qty: 0 }}}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")
            
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

export const removeSplitItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId

        const splitItem = {
            userId: user._id,
            ...req.body
        }

        const isItemThere = await CartModel.findOne({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } })

        if (isItemThere) {
            // const decreasedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: { menuId: splitItem.menuId , userId: user._id} } }, { $inc: { "split.$.qty": -(1) }})
            const decreasedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $set: { "split.$.qty": 0 }}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")
            
            const removedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $pull: { split: { qty: 0 }}}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")
            
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
export const checkOutSplitItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId

        const splitItem = {
            userId: user._id,
            ...req.body
        }

        const item = req.body.item

        const isItemThere = await CartModel.findOne({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } })

        if (isItemThere) {
            // const decreasedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: { menuId: splitItem.menuId , userId: user._id} } }, { $inc: { "split.$.qty": -(1) }})
            const checkOutItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $set: { "split.$.splitStatus": "closed" }}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")
            // console.log("checkOutItem: ", checkOutItem)
            
            const updatedCart = await CartModel.findOneAndUpdate({_id: cartId, items: { $elemMatch: {menuId: splitItem.menuId} }}, { $inc: { "items.$.qtyPayed": req.body.qty }}).populate("items.menuId", "name short_description image price").populate("split.menuId", "name short_description image price")
            // console.log("updatedCart: ", updatedCart)
            
            const payedItems = updatedCart.items.filter(item => item.qty <= item.qtyPayed).length
            // console.log("payedItems: ", payedItems)

            if ( payedItems === updatedCart.items.length ) {

                const checkOutCart = await CartModel.findByIdAndUpdate(cartId, {status: "closed"}).populate("items.menuId", "name short_description image price").populate("split.menuId", "name short_description image price")
                console.log("checkOutCart: ", checkOutCart)
                res.send(checkOutCart)
            }
            else if (updatedCart) {
                res.send(updatedCart)
            } else {
                res.status(404).send("Item Not Found!")
            }
        } else {
            res.status(404).send("Item Not Found!")
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}