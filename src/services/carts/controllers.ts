import { TController } from "src/typings/controllers"
import { IUserDocument } from "src/typings/users"
import { ICartDocument, ISplitItem } from "src/typings/cart"
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
        const { menuId, qty } = req.body as { menuId: string; qty: number }

        // Availability guard: a split can only claim units that actually exist.
        // The units already claimed by ALL diners' open splits for this item, plus
        // this request's qty and the already-paid units, can never exceed the item
        // quantity — otherwise two customers could hold splits on the same unit and
        // both pay for it. A pre-check is enough here; checkOutSplit re-verifies
        // authoritatively at settlement time (closing the residual TOCTOU window).
        const cart = await CartModel.findOne({ _id: cartId, status: "open" })
        if (!cart) return next(createError(404, "Cart Not Found!"))

        const item = cart.items.find((i) => i.menuId.toString() === menuId.toString())
        if (!item) return next(createError(404, "Item Not Found in Cart!"))

        const claimed = cart.split
            .filter((s) => s.menuId.toString() === menuId.toString() && s.splitStatus === "open")
            .reduce((sum, s) => sum + s.qty, 0)

        if (claimed + qty + item.qtyPayed > item.qty) {
            return next(createError(409, "Not enough units left to split"))
        }

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
// A cart is shared by many payers, so each settlement is recorded in
// `paypalOrderIds`; a given order id can only ever settle one checkout across all
// carts (replay protection), and optimistic concurrency serialises simultaneous
// payers so no unit is double-settled and no recorded order id is lost.
type PopulatedMenuRef = { _id: mongoose.Types.ObjectId; price: number }

const menuIdOf = (ref: ISplitItem["menuId"]): string => {
    const populated = ref as unknown as PopulatedMenuRef
    return (populated._id ?? ref).toString()
}

const loadOpenCart = (cartId: string) =>
    CartModel.findOne({ _id: cartId, status: "open" })
        .populate("split.menuId", "name short_description image price")
        .populate("items.menuId", "name short_description image price")

const callerOpenSplits = (cart: ICartDocument, userId: mongoose.Types.ObjectId): ISplitItem[] =>
    cart.split.filter((s) => s.userId.toString() === userId.toString() && s.splitStatus === "open")

// Expected total from DB prices only — never from anything the client sent.
const expectedTotalFor = (openSplits: ISplitItem[]): number =>
    openSplits.reduce((sum, s) => sum + (s.menuId as unknown as PopulatedMenuRef).price * s.qty, 0)

// The caller may not settle more units of an item than remain unpaid — another
// payer may already hold or have settled some of them.
const availabilityError = (cart: ICartDocument, openSplits: ISplitItem[]): string | null => {
    for (const split of openSplits) {
        const item = cart.items.find((i) => menuIdOf(i.menuId) === menuIdOf(split.menuId))
        if (!item) return "A split item is no longer in the cart"
        if (split.qty > item.qty - item.qtyPayed) return "Not enough unpaid units left to settle this checkout"
    }
    return null
}

// The PayPal order must be COMPLETED, its capture COMPLETED, in GBP, for exactly
// the amount due. Returns a message on any mismatch, or null when it verifies.
const orderVerificationError = (order: PayPalOrder, expectedTotal: number): string | null => {
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0]
    if (
        order.status !== "COMPLETED" ||
        capture?.status !== "COMPLETED" ||
        capture?.amount?.currency_code !== "GBP" ||
        capture?.amount?.value !== expectedTotal.toFixed(2)
    ) {
        return "PayPal payment does not match the amount due"
    }
    return null
}

// Apply exactly what N checkOutSplitItem calls do today, in memory on the loaded
// doc, for a single version-checked save().
const applyCheckout = (cart: ICartDocument, openSplits: ISplitItem[], paypalOrderId: string) => {
    for (const split of openSplits) {
        split.splitStatus = "closed"
        const item = cart.items.find((i) => menuIdOf(i.menuId) === menuIdOf(split.menuId))
        if (item) item.qtyPayed += split.qty
    }
    if (!cart.paypalOrderIds) cart.paypalOrderIds = []
    cart.paypalOrderIds.push(paypalOrderId)
    if (cart.items.every((i) => i.qty <= i.qtyPayed)) cart.status = "closed"
}

export const checkOutSplit: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId
        const { paypalOrderId } = req.body as { paypalOrderId: string }

        // Replay protection: reject an order id already recorded on any cart —
        // in the per-payer array or the legacy scalar — before touching anything.
        const alreadyUsed = await CartModel.findOne({
            $or: [{ paypalOrderIds: paypalOrderId }, { paypalOrderId }],
        })
        if (alreadyUsed) return next(createError(402, "This PayPal order has already been used"))

        let cart = await loadOpenCart(cartId)
        if (!cart) return next(createError(404, "Cart Not Found!"))

        let openSplits = callerOpenSplits(cart, user._id)
        if (openSplits.length === 0) return next(createError(404, "No open split items to pay!"))

        // Availability guard BEFORE paying: never settle more units than remain.
        const availError = availabilityError(cart, openSplits)
        if (availError) return next(createError(409, availError))

        // Verify the payment against PayPal's record of the order — ONCE. The order
        // is immutable, so a version-conflict retry re-checks this same fetched
        // result (recomputed against the reloaded doc) rather than re-calling PayPal.
        let order: PayPalOrder
        try {
            order = await getOrder(paypalOrderId)
        } catch {
            return next(createError(402, "Could not verify PayPal payment"))
        }

        const verifyError = orderVerificationError(order, expectedTotalFor(openSplits))
        if (verifyError) return next(createError(402, verifyError))

        // Apply + persist under optimistic concurrency. A concurrent payer's save
        // bumps __v and makes ours throw VersionError; on that, reload, re-derive
        // everything from the fresh doc, re-verify against the already-fetched
        // order, and retry a bounded number of times.
        const MAX_ATTEMPTS = 3
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            applyCheckout(cart, openSplits, paypalOrderId)
            try {
                await cart.save()
                res.send(cart)
                return
            } catch (error) {
                const err = error as { code?: number; cause?: { code?: number }; name?: string }
                if (err.code === 11000 || err.cause?.code === 11000) {
                    return next(createError(402, "This PayPal order has already been used"))
                }
                if (err.name !== "VersionError") throw error
                if (attempt === MAX_ATTEMPTS) {
                    return next(createError(409, "Checkout conflicted with a concurrent payment, please retry"))
                }

                // Reload and re-derive from the fresh doc before the next attempt.
                const reloaded = await loadOpenCart(cartId)
                if (!reloaded) return next(createError(404, "Cart Not Found!"))
                // Re-check replay too: the payer we just conflicted with may have
                // recorded THIS very order id — on this same cart, where the
                // unique index can't help (duplicates within one document's
                // array don't violate a multikey unique index).
                const replayed = await CartModel.findOne({
                    $or: [{ paypalOrderIds: paypalOrderId }, { paypalOrderId }],
                })
                if (replayed) return next(createError(402, "This PayPal order has already been used"))
                cart = reloaded
                openSplits = callerOpenSplits(cart, user._id)
                if (openSplits.length === 0) return next(createError(404, "No open split items to pay!"))
                const reAvailError = availabilityError(cart, openSplits)
                if (reAvailError) return next(createError(409, reAvailError))
                const reVerifyError = orderVerificationError(order, expectedTotalFor(openSplits))
                if (reVerifyError) return next(createError(402, reVerifyError))
            }
        }

        // Unreachable: every loop iteration returns or throws. Kept as a safety net.
        next(createError(409, "Checkout could not be completed"))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------