import { TController } from "src/typings/controllers"
import { IUserDocument } from "src/typings/users"
import { ICartDocument, ISplitItem } from "src/typings/cart"
import CartModel from "./model"
import createError from "http-errors"
import mongoose from "mongoose"
import { getOrder, createOrder, captureOrder, refundCapture, PayPalOrder } from "../../lib/paypal"

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
        // both pay for it. A pre-check is enough here; captureCheckout re-verifies
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

// Apply what a settlement does, in memory on the loaded doc, for a single
// version-checked save(): close the caller's open splits and credit qtyPayed.
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

// Outcome of a settlement attempt. Returned (not sent) so captureCheckout can
// refund the buyer before reporting a failure that happened after money moved.
type SettleOutcome =
    | { ok: true; cart: ICartDocument }
    | { ok: false; status: number; message: string }

// Apply + persist the settlement under optimistic concurrency. A concurrent
// payer's save bumps __v and makes ours throw VersionError; on that, reload,
// re-derive everything from the fresh doc, re-check replay/availability, re-verify
// against the already-known (immutable) `order`, and retry a bounded number of
// times. `order` is captureCheckout's own COMPLETED capture result.
const settleCheckout = async (
    cartId: string,
    initialCart: ICartDocument,
    initialSplits: ISplitItem[],
    userId: mongoose.Types.ObjectId,
    paypalOrderId: string,
    order: PayPalOrder
): Promise<SettleOutcome> => {
    let cart = initialCart
    let openSplits = initialSplits

    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        applyCheckout(cart, openSplits, paypalOrderId)
        try {
            await cart.save()
            return { ok: true, cart }
        } catch (error) {
            const err = error as { code?: number; cause?: { code?: number }; name?: string }
            if (err.code === 11000 || err.cause?.code === 11000) {
                return { ok: false, status: 402, message: "This PayPal order has already been used" }
            }
            if (err.name !== "VersionError") throw error
            if (attempt === MAX_ATTEMPTS) {
                return { ok: false, status: 409, message: "Checkout conflicted with a concurrent payment, please retry" }
            }

            // Reload and re-derive from the fresh doc before the next attempt.
            const reloaded = await loadOpenCart(cartId)
            if (!reloaded) return { ok: false, status: 404, message: "Cart Not Found!" }
            // Re-check replay too: the payer we just conflicted with may have
            // recorded THIS very order id — on this same cart, where the unique
            // index can't help (duplicates within one document's array don't
            // violate a multikey unique index).
            const replayed = await CartModel.findOne({
                $or: [{ paypalOrderIds: paypalOrderId }, { paypalOrderId }],
            })
            if (replayed) return { ok: false, status: 402, message: "This PayPal order has already been used" }
            cart = reloaded
            openSplits = callerOpenSplits(cart, userId)
            if (openSplits.length === 0) return { ok: false, status: 404, message: "No open split items to pay!" }
            const reAvailError = availabilityError(cart, openSplits)
            if (reAvailError) return { ok: false, status: 409, message: reAvailError }
            const reVerifyError = orderVerificationError(order, expectedTotalFor(openSplits))
            if (reVerifyError) return { ok: false, status: 402, message: reVerifyError }
        }
    }

    // Unreachable: every loop iteration returns or throws. Kept as a safety net.
    return { ok: false, status: 409, message: "Checkout could not be completed" }
}

// Server-side checkout, step 1 of 2: create the PayPal order for the exact
// amount the caller owes (DB prices only) and bind it to this cart + payer via
// custom_id. Nothing is charged or persisted here — the buyer approves the
// returned order in the popup, then hits captureCheckout. The availability guard
// runs BEFORE PayPal is called, so a doomed checkout never mints an order.
export const createCheckoutOrder: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId

        const cart = await loadOpenCart(cartId)
        if (!cart) return next(createError(404, "Cart Not Found!"))

        const openSplits = callerOpenSplits(cart, user._id)
        if (openSplits.length === 0) return next(createError(404, "No open split items to pay!"))

        const availError = availabilityError(cart, openSplits)
        if (availError) return next(createError(409, availError))

        const expectedTotal = expectedTotalFor(openSplits)

        try {
            const paypalOrderId = await createOrder(expectedTotal.toFixed(2), `${cartId}:${user._id}`)
            res.send({ paypalOrderId })
        } catch {
            return next(createError(502, "Could not create PayPal order"))
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

// Server-side checkout, step 2 of 2: the money-moving endpoint. Verifies the
// buyer-approved order was minted for THIS cart+payer and still matches the
// amount due, re-checks availability, and only THEN captures. If a concurrent
// payer takes the units in the tiny window after capture, the buyer is refunded
// automatically — a rejection here never leaves someone charged for nothing.
export const captureCheckout: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId
        const { paypalOrderId } = req.body as { paypalOrderId: string }

        // (a) Replay protection before anything — an id recorded on any cart,
        // in the per-payer array or the legacy scalar, is rejected uncharged.
        const alreadyUsed = await CartModel.findOne({
            $or: [{ paypalOrderIds: paypalOrderId }, { paypalOrderId }],
        })
        if (alreadyUsed) return next(createError(402, "This PayPal order has already been used"))

        // (b) Load the open cart + the caller's open splits.
        const cart = await loadOpenCart(cartId)
        if (!cart) return next(createError(404, "Cart Not Found!"))

        const openSplits = callerOpenSplits(cart, user._id)
        if (openSplits.length === 0) return next(createError(404, "No open split items to pay!"))

        // (c) Fetch the order and confirm it is a buyer-approved order minted for
        // THIS cart + payer, for exactly the amount still due. Nothing is charged.
        let order: PayPalOrder
        try {
            order = await getOrder(paypalOrderId)
        } catch {
            return next(createError(402, "Could not verify PayPal payment"))
        }

        if (order.status !== "APPROVED") {
            return next(createError(402, "PayPal order is not approved for capture"))
        }
        if (order.purchase_units?.[0]?.custom_id !== `${cartId}:${user._id}`) {
            return next(createError(402, "PayPal order was not created for this checkout"))
        }
        const expectedTotal = expectedTotalFor(openSplits)
        const amount = order.purchase_units?.[0]?.amount
        if (amount?.currency_code !== "GBP" || amount?.value !== expectedTotal.toFixed(2)) {
            return next(createError(409, "Your selection changed since the order was created, please retry"))
        }

        // (d) Availability guard — still nothing charged.
        const availError = availabilityError(cart, openSplits)
        if (availError) return next(createError(409, availError))

        // (e) Only now capture the money.
        let captured: PayPalOrder
        try {
            captured = await captureOrder(paypalOrderId)
        } catch {
            return next(createError(402, "PayPal capture failed"))
        }

        const capture = captured.purchase_units?.[0]?.payments?.captures?.[0]
        if (captured.status !== "COMPLETED" || capture?.status !== "COMPLETED") {
            // Capture did not go through — no money moved, so no refund needed.
            return next(createError(402, "PayPal capture did not complete"))
        }
        const captureId = capture.id

        // (f) Settle under optimistic concurrency, re-verifying against our own
        // capture result on any version conflict.
        const outcome = await settleCheckout(cartId, cart, openSplits, user._id, paypalOrderId, captured)
        if (outcome.ok) return res.send(outcome.cart)

        // (g) The buyer HAS been charged but the settlement is impossible (a
        // concurrent payer took the units, a replay was hit, or attempts were
        // exhausted). Make them whole with a refund, then report the conflict.
        try {
            if (!captureId) throw new Error("capture id missing from PayPal response")
            await refundCapture(captureId)
        } catch (refundError) {
            console.error("PayPal refund failed after capture", {
                paypalOrderId,
                settlement: outcome.message,
                error: refundError,
            })
            return next(createError(500, `Payment captured but could not be settled or refunded — please contact staff (order ${paypalOrderId})`))
        }
        return next(createError(409, "A concurrent payment took these items — your payment was refunded"))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------