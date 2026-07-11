import { TController } from "src/typings/controllers"
import { IUserDocument } from "src/typings/users"
import CartModel from "./model"
import createError from "http-errors"
import mongoose from "mongoose"
import { getOrder, PayPalOrder } from "../../lib/paypal"

// -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------

export const getTableCart: TController = async ( req, res, next ) => {
    try {
        const tableId = req.params.tableId

        // Newest first: legacy data may hold more than one open cart per table
        // (addItem used to key carts per-user), so resolve to the latest one.
        const cart = await CartModel.findOne({$and: [{ tableId: tableId}, {status: "open"}]})
            .sort({ createdAt: -1 })
            .populate("items.menuId", "name short_description image price")
            .populate("split.menuId", "name short_description image price")

        if (!cart) return next(createError(404, `Cart Not Found!`))
        
        res.send(cart)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const getSingleCart: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument

        const cart = await CartModel.findOne({
            _id: req.params.cartId,
            $or: [{ userId: user._id }, { "split.userId": user._id }],
        })
            .populate("items.menuId", "name short_description image price")
            .populate("split.menuId", "name short_description image price")

        if (!cart) return next(createError(404, `Cart Not Found!`))
        
        res.send(cart)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const addItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const tableId = req.params.tableId
        const item = req.body

        // A table has ONE shared open cart: whoever orders first creates it,
        // everyone else at the table adds to it (the split array tracks who
        // pays for what). Keying by userId here used to spawn a duplicate cart
        // per user, which getTableCart could not disambiguate.
        const isItemThere = await CartModel.findOne({tableId: tableId, status: "open", "items.menuId": item.menuId})

        if (isItemThere) {
            const updatedItem = await CartModel.findOneAndUpdate({tableId: tableId, status: "open", "items.menuId": item.menuId}, { $inc: { "items.$.qty": req.body.qty }}, { sort: { createdAt: -1 } }).populate("items.menuId", "name short_description image price")
            res.send(updatedItem)
        } else {
            const addedItem = await CartModel.findOneAndUpdate({tableId: tableId, status: "open"}, { $push: { items: item }, $setOnInsert: { userId: user._id, shopId: req.params.shopId }}, { upsert: true, sort: { createdAt: -1 } }).populate("items.menuId", "name short_description image price")
            res.send(addedItem)
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const decreaseItem: TController = async ( req, res, next ) => {
    try {
        const tableId = req.params.tableId
        const item = req.body

        const isItemThere = await CartModel.findOne({tableId: tableId, status: "open", "items.menuId": item.menuId})

        if (isItemThere) {
            const decreasedItem = await CartModel.findOneAndUpdate({tableId: tableId, status: "open", "items.menuId": item.menuId}, { $inc: { "items.$.qty": -(req.body.qty) }}, { sort: { createdAt: -1 } }).populate("items.menuId", "name short_description image price")

            const removedItem = await CartModel.findOneAndUpdate({tableId: tableId, status: "open", "items.menuId": item.menuId}, { $pull: { items: { qty: { $lte: 0 } }}}, { sort: { createdAt: -1 } }).populate("items.menuId", "name short_description image price")

            const deleteCart = await CartModel.findOneAndDelete({tableId: tableId, status: "open", items: []}, { sort: { createdAt: -1 } }).populate("items.menuId", "name short_description image price")
            
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

// -------------------------------------------------------------------------

export const deleteItem: TController = async ( req, res, next ) => {
    try {
        const tableId = req.params.tableId
        const item = req.body

        const isItemThere = await CartModel.findOne({tableId: tableId, status: "open", "items.menuId": item.menuId})

        if (isItemThere) {
            await CartModel.findOneAndUpdate({tableId: tableId, status: "open", "items.menuId": item.menuId}, { $set: { "items.$.qty": 0 }}, { sort: { createdAt: -1 } }).populate("items.menuId", "name short_description image price")

            const removedItem = await CartModel.findOneAndUpdate({tableId: tableId, status: "open", "items.menuId": item.menuId}, { $pull: { items: { qty: 0 }}}, { sort: { createdAt: -1 } }).populate("items.menuId", "name short_description image price")

            res.send(removedItem)

        } else {
            res.status(404).send("Item Not Found in Cart!")
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const addSplitItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId

        const splitItem = {
            userId: user._id,
            ...req.body
        }

        const isItemThere = await CartModel.findOne({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } })

        if (isItemThere) {
            const updatedSplit = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $inc: { "split.$.qty": req.body.qty }}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")
            res.send(updatedSplit)

        } else {
            const addedItem = await CartModel.findOneAndUpdate({ _id: cartId, status: "open" }, { $push: { split: splitItem }}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")
            res.send(addedItem)
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const decreaseSplitItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId

        const splitItem = {
            userId: user._id,
            ...req.body
        }

        const isItemThere = await CartModel.findOne({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } })

        if (isItemThere) {
            const decreasedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $inc: { "split.$.qty": -(1) }}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")

            const removedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $pull: { split: { qty: { $lte: 0 } }}}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")
            
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

// -------------------------------------------------------------------------

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
            const decreasedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $set: { "split.$.qty": 0 }}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")

            const removedItem = await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $pull: { split: { qty: { $lte: 0 } }}}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")

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

// -------------------------------------------------------------------------
}
export const checkOutSplitItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId

        const splitItem = {
            userId: user._id,
            ...req.body
        }

        const isItemThere = await CartModel.findOne({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } })

        if (isItemThere) {
            await CartModel.findOneAndUpdate({_id: cartId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $set: { "split.$.splitStatus": "closed" }}).populate("split.menuId", "name short_description image price").populate("items.menuId", "name short_description image price")

            const updatedCart = await CartModel.findOneAndUpdate({_id: cartId, items: { $elemMatch: {menuId: splitItem.menuId} }}, { $inc: { "items.$.qtyPayed": req.body.qty }}).populate("items.menuId", "name short_description image price").populate("split.menuId", "name short_description image price")

            const payedItems = updatedCart && updatedCart.items.filter(item => item.qty <= item.qtyPayed).length

            if ( updatedCart && payedItems === updatedCart.items.length ) {

                const checkOutCart = await CartModel.findByIdAndUpdate(cartId, {status: "closed"}).populate("items.menuId", "name short_description image price").populate("split.menuId", "name short_description image price")
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

// -------------------------------------------------------------------------

// Verified split checkout: settles the requesting user's open split items only
// after confirming, server-side, that the referenced PayPal order was actually
// paid for the exact amount due (computed from DB prices, never from the client).
// A `paypalOrderId` can only ever settle one checkout (replay protection).
type PopulatedMenuRef = { _id: mongoose.Types.ObjectId; price: number }

export const checkOutSplit: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId
        const { paypalOrderId } = req.body as { paypalOrderId: string }

        // Replay protection: reject an order id already recorded on any cart,
        // before touching anything.
        const alreadyUsed = await CartModel.findOne({ paypalOrderId })
        if (alreadyUsed) return next(createError(402, "This PayPal order has already been used"))

        const cart = await CartModel.findOne({ _id: cartId, status: "open" })
            .populate("split.menuId", "name short_description image price")
            .populate("items.menuId", "name short_description image price")

        if (!cart) return next(createError(404, "Cart Not Found!"))

        // Only the caller's still-open split entries can be paid by this checkout.
        const openSplits = cart.split.filter(
            (s) => s.userId.toString() === user._id.toString() && s.splitStatus === "open"
        )
        if (openSplits.length === 0) return next(createError(404, "No open split items to pay!"))

        // Expected total from DB prices only — never from anything the client sent.
        const expectedTotal = openSplits.reduce((sum, s) => {
            const menu = s.menuId as unknown as PopulatedMenuRef
            return sum + menu.price * s.qty
        }, 0)

        // Verify the payment against PayPal's record of the order.
        let order: PayPalOrder
        try {
            order = await getOrder(paypalOrderId)
        } catch {
            return next(createError(402, "Could not verify PayPal payment"))
        }

        const capture = order.purchase_units?.[0]?.payments?.captures?.[0]
        if (
            order.status !== "COMPLETED" ||
            capture?.status !== "COMPLETED" ||
            capture?.amount?.currency_code !== "GBP" ||
            capture?.amount?.value !== expectedTotal.toFixed(2)
        ) {
            return next(createError(402, "PayPal payment does not match the amount due"))
        }

        // Payment verified — apply exactly what N checkOutSplitItem calls do today,
        // persisted in a single save() so a failure leaves the cart untouched.
        for (const split of openSplits) {
            split.splitStatus = "closed"
            const splitMenuId = (split.menuId as unknown as PopulatedMenuRef)._id
            const item = cart.items.find(
                (i) => (i.menuId as unknown as PopulatedMenuRef)._id.toString() === splitMenuId.toString()
            )
            if (item) item.qtyPayed += split.qty
        }

        cart.paypalOrderId = paypalOrderId

        if (cart.items.every((i) => i.qty <= i.qtyPayed)) cart.status = "closed"

        try {
            await cart.save()
        } catch (error) {
            const err = error as { code?: number; cause?: { code?: number } }
            if (err.code === 11000 || err.cause?.code === 11000) {
                return next(createError(402, "This PayPal order has already been used"))
            }
            throw error
        }

        res.send(cart)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------