import { TController } from "src/typings/controllers"
import { IUserDocument } from "src/typings/users"
import { ICartDocument, ISplitItem } from "src/typings/cart"
import CartModel, { dinerView } from "./model"
import { Request } from "express"
import createError from "http-errors"
import mongoose from "mongoose"
import { getOrder, createOrder, captureOrder, refundCapture, PayPalOrder, PayPalCaptureRefused } from "../../lib/paypal"
import MenuModel from "../menus/model"
import ShopModel from "../shops/model"

// Menu fields every cart response populates. `available` is included so the FE
// can flag items that sold out after being added, and the checkout guards read
// it from the populated splits.
const MENU_FIELDS = "name short_description image price available"

// A cart keeps referencing a menu item after the manager deletes it, and a plain
// populate turns that reference into null: the item's id is lost, so nothing
// could match, remove or un-select the line, and code reading `menuId._id`
// crashed. Such an item is shown instead as a sold-out stand-in carrying its
// id. Sold out means it can't be claimed or paid for, and the existing
// "remove them to pay for the rest" flow clears it; the price is never charged.
export const menuRef = (path: string) => ({
    path,
    select: MENU_FIELDS,
    transform: (doc: unknown, id: unknown) =>
        doc ?? { _id: id, name: "No longer on the menu", short_description: "", price: 0, available: false },
})

// A cart as the caller may see it: the diner view, including the notices meant
// for them (the public table view only has the table-wide ones).
const forDiner = (cart: ICartDocument | null, req: Request) =>
    cart && dinerView(cart, (req.user as IUserDocument | undefined)?._id)

// Sold-out rule (S21, user decision 2026-09-22): the kitchen only acts on PAID
// orders, so an unavailable item can't be added, newly split, or paid for.
// Nothing is removed from carts automatically, and paid units are never touched.
const SOLD_OUT = "This item is sold out"
const SOLD_OUT_CHECKOUT = "Some items you selected are sold out — remove them to pay for the rest"

// -------------------------------------------------------------------------

export const getMyCarts: TController = async ( req, res, next) => {
    try {
        const user = req.user as IUserDocument

        const myCarts = await CartModel.findOne({ userId: user._id, status: "open" })
            .populate(menuRef("items.menuId"))
            .populate(menuRef("split.menuId"))
            
        if (!myCarts) return next(createError(404, "Carts Not Found!"))

        res.send(forDiner(myCarts, req))
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
            .populate(menuRef("items.menuId"))
            .populate(menuRef("split.menuId"))

        if (!cart) return next(createError(404, `Cart Not Found!`))
        
        res.send(forDiner(cart, req))
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
            .populate(menuRef("items.menuId"))
            .populate(menuRef("split.menuId"))

        if (!cart) return next(createError(404, `Cart Not Found!`))
        
        res.send(forDiner(cart, req))
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

        // The item must exist, be on THIS shop's menu (same 404 either way, so
        // another shop's items aren't revealed), and not be sold out. The window
        // between this check and the write is accepted: checkout re-checks
        // availability before any money moves.
        const shopId = req.params.shopId
        const menuItem = mongoose.isValidObjectId(shopId)
            ? await MenuModel.findById(item.menuId).select("available")
            : null
        const onShopMenu = menuItem && await ShopModel.exists({ _id: shopId, menu: item.menuId })
        if (!menuItem || !onShopMenu) return next(createError(404, "Menu Item Not Found!"))
        // And the table must be one of the shop's: a deleted table's page left
        // open would otherwise start a cart no manager can see or close.
        const atShopTable = mongoose.isValidObjectId(tableId) && await ShopModel.exists({ _id: shopId, "tables._id": tableId })
        if (!atShopTable) return next(createError(404, "Table Not Found!"))
        if (!menuItem.available) return next(createError(409, SOLD_OUT))

        // A table has ONE shared open cart: whoever orders first creates it,
        // everyone else at the table adds to it (the split array tracks who
        // pays for what). Keying by userId here used to spawn a duplicate cart
        // per user, which getTableCart could not disambiguate.
        //
        // Each step is one atomic update: add to the item's line if the open
        // cart has one; else add the line to the open cart, creating the cart
        // if the table has none. Racing another diner, the second step can find
        // the line or the cart just created: its insert then breaks the
        // one-open-cart-per-table index (11000) and the pair is tried again,
        // now landing on the first step.
        for (let attempt = 0; attempt < 3; attempt++) {
            const updatedItem = await CartModel.findOneAndUpdate({tableId: tableId, status: "open", "items.menuId": item.menuId}, { $inc: { "items.$.qty": req.body.qty }}, { sort: { createdAt: -1 } }).populate(menuRef("items.menuId"))
            if (updatedItem) return res.send(forDiner(updatedItem, req))

            try {
                const addedItem = await CartModel.findOneAndUpdate({tableId: tableId, status: "open", "items.menuId": { $ne: item.menuId }}, { $push: { items: item }, $setOnInsert: { userId: user._id, shopId: req.params.shopId }}, { upsert: true, sort: { createdAt: -1 } }).populate(menuRef("items.menuId"))
                return res.send(forDiner(addedItem, req))
            } catch (error) {
                const err = error as { code?: number; cause?: { code?: number } }
                if (err.code !== 11000 && err.cause?.code !== 11000) throw error
            }
        }
        next(createError(409, "The cart changed, please retry"))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const decreaseItem: TController = async ( req, res, next ) => {
    try {
        const tableId = req.params.tableId
        const item = req.body

        const isItemThere = await CartModel.findOne({tableId: tableId, status: "open", "items.menuId": item.menuId}).sort({ createdAt: -1 })

        if (isItemThere) {
            // Never decrease into units that are paid for (erasing the payment
            // record) or held in someone's open split (stranding their checkout).
            // Only enforced when such units exist, so an unpaid, unclaimed line
            // can still be decreased away entirely as before. A pre-check: the
            // window before the $inc is accepted, like addItem's.
            const floor = lockedUnits(isItemThere, item.menuId)
            const line = isItemThere.items.find((i) => i.menuId.toString() === item.menuId.toString())
            if (line && floor > 0 && line.qty - req.body.qty < floor) {
                return next(createError(409, "Those units are already paid for or selected for payment"))
            }

            const decreasedItem = await CartModel.findOneAndUpdate({tableId: tableId, status: "open", "items.menuId": item.menuId}, { $inc: { "items.$.qty": -(req.body.qty) }}, { sort: { createdAt: -1 } }).populate(menuRef("items.menuId"))

            const removedItem = await CartModel.findOneAndUpdate({tableId: tableId, status: "open", "items.menuId": item.menuId}, { $pull: { items: { qty: { $lte: 0 } }}}, { sort: { createdAt: -1 } }).populate(menuRef("items.menuId"))

            // An emptied cart goes, unless it holds payment or refund records
            // (a refund takes its units out of the cart): those must stay, so
            // it closes below instead.
            const deleteCart = await CartModel.findOneAndDelete({
                _id: isItemThere._id, status: "open", items: [],
                "payments.0": { $exists: false }, "refunds.0": { $exists: false },
            }).populate(menuRef("items.menuId"))

            // Taking off the last unpaid units can leave everything paid: then
            // the table is finished, the same rule deleteItem and a checkout
            // apply. Left open, the next party at the table would inherit it.
            // By id: the decreased line may be gone from the cart by now.
            const closedCart = deleteCart ? null : await CartModel.findOneAndUpdate(
                { _id: isItemThere._id, status: "open", ...allItemsPaid },
                { $set: { status: "closed" } },
                { sort: { createdAt: -1 } }
            ).populate(menuRef("items.menuId"))

            if (deleteCart) {
                res.status(204).send()
            } else if (closedCart) {
                res.send(forDiner(closedCart, req))
            } else if (removedItem) {
                res.send(forDiner(removedItem, req))
            } else {
                res.send(forDiner(decreasedItem, req))
            }

        } else {
            res.status(404).send("Item Not Found in Cart!")
        }
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

// A cart with nothing left to pay (every item fully paid, or no items left
// beside its payment records) and no payment still pending (see
// closeIfPaidOff), as a query condition.
const allItemsPaid = {
    payments: { $not: { $elemMatch: { status: "pending" } } },
    $expr: {
        $allElementsTrue: [{
            $map: { input: "$items", in: { $lte: ["$$this.qty", { $ifNull: ["$$this.qtyPayed", 0] }] } },
        }],
    },
}

// Units of an item that must survive any decrease: those already paid, plus
// those held in any diner's open split.
const lockedUnits = (cart: ICartDocument, menuId: string): number => {
    const line = cart.items.find((i) => i.menuId.toString() === menuId.toString())
    const claimed = cart.split
        .filter((s) => s.splitStatus === "open" && s.menuId.toString() === menuId.toString())
        .reduce((sum, s) => sum + s.qty, 0)
    return (line?.qtyPayed ?? 0) + claimed
}

// Removes an item's unpaid units from a loaded cart, in memory (the caller
// saves): the rule of the diner's bin (deleteItem) and the manager's removeItem.
// Returns how many units went. See deleteItem for the rule.
export const removeUnpaidUnits = (cart: ICartDocument, menuId: string) => {
    // Works on a populated cart too (menuId is then the menu document).
    const sameItem = (id: unknown) => String((id as { _id?: unknown } | null)?._id ?? id) === String(menuId)
    const line = cart.items.find((i) => sameItem(i.menuId))
    const removed = line ? line.qty - line.qtyPayed : 0
    if (line && line.qtyPayed > 0) {
        line.qty = line.qtyPayed
    } else {
        cart.items = cart.items.filter((i) => !sameItem(i.menuId))
    }
    cart.split = cart.split.filter((s) => !(s.splitStatus === "open" && sameItem(s.menuId)))
    // Same rule settleCheckout applies after a payment: nothing left to pay
    // means the table is finished, unless a payment is still pending. That
    // includes a cart left with no items beside its payments (refunds take
    // their units out).
    if (cart.items.length > 0 || cart.payments.length > 0) closeIfPaidOff(cart)
    return removed
}

// Removes only the UNPAID units of an item. A partly-paid line is kept with
// qty === qtyPayed as the record of what was paid; an unpaid line is dropped.
// Every diner's open split on it goes too — those units no longer exist. This is
// how a sold-out item leaves a cart (nothing removes it automatically).
// Version-checked save() (optimisticConcurrency on the schema), so a payment
// settling at the same moment conflicts loudly instead of being overwritten;
// settleCheckout's own retry then re-reads the cart and sees the removal.
export const deleteItem: TController = async ( req, res, next ) => {
    try {
        const tableId = req.params.tableId
        const menuId = (req.body as { menuId: string }).menuId

        const cart = await CartModel.findOne({tableId: tableId, status: "open", "items.menuId": menuId}).sort({ createdAt: -1 })
        if (!cart) {
            res.status(404).send("Item Not Found in Cart!")
            return
        }

        removeUnpaidUnits(cart, menuId)

        try {
            await cart.save()
        } catch (error) {
            if ((error as { name?: string }).name === "VersionError") {
                return next(createError(409, "The cart changed, please retry"))
            }
            throw error
        }

        res.send(forDiner(await cart.populate([menuRef("items.menuId"), menuRef("split.menuId")]), req))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

// The availability rule as a query condition: the units every diner's open
// split already holds for this item, plus the request, plus the paid units, must
// fit in the item's quantity. It goes in the FILTER of the update, so checking
// and claiming are one atomic step on the cart document: of two requests racing
// for the last unit, the second no longer matches and claims nothing. (Checked
// on a separate read first, concurrent requests all passed and the split grew
// past the item — one diner tapping + fast, or two diners at once.) $expr isn't
// cast by Mongoose, so ids come in as ObjectIds.
const fitsInItem = (menuId: mongoose.Types.ObjectId, qty: number) => ({
    $expr: {
        $let: {
            vars: {
                item: {
                    $arrayElemAt: [
                        { $filter: { input: "$items", cond: { $eq: ["$$this.menuId", menuId] } } },
                        0,
                    ],
                },
                claimed: {
                    $sum: {
                        $map: {
                            input: {
                                $filter: {
                                    input: "$split",
                                    cond: {
                                        $and: [
                                            { $eq: ["$$this.menuId", menuId] },
                                            { $eq: ["$$this.splitStatus", "open"] },
                                        ],
                                    },
                                },
                            },
                            in: "$$this.qty",
                        },
                    },
                },
            },
            in: {
                $lte: [
                    { $add: ["$$claimed", qty, { $ifNull: ["$$item.qtyPayed", 0] }] },
                    "$$item.qty",
                ],
            },
        },
    },
})

export const addSplitItem: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const cartId = req.params.cartId
        const { menuId, qty } = req.body as { menuId: string; qty: number }

        // Plain reads for the 404s and the sold-out rule. They are not the
        // availability guard — that lives in the updates below.
        const tableId = req.params.tableId
        const cart = await CartModel.findOne({ _id: cartId, tableId, status: "open" })
        if (!cart) return next(createError(404, "Cart Not Found!"))

        const item = cart.items.find((i) => i.menuId.toString() === menuId.toString())
        if (!item) return next(createError(404, "Item Not Found in Cart!"))

        // No new claims on a sold-out item (a deleted menu item counts as sold
        // out). Shrinking or dropping one's own split stays allowed — that's how
        // a diner un-selects it.
        const menuItem = await MenuModel.findById(menuId).select("available")
        if (!menuItem?.available) return next(createError(409, SOLD_OUT))

        const menuOid = new mongoose.Types.ObjectId(menuId)
        const mine = { userId: user._id, menuId: menuOid, splitStatus: "open" }
        const fits = fitsInItem(menuOid, qty)

        // Grow my open split for this item, or start one: each a single
        // conditional update. The $not on the push also stops two concurrent
        // first claims from creating two entries for the same diner. Whichever
        // of the pair doesn't match can flip between the two calls (my own
        // concurrent request just created the entry), so try the pair twice.
        for (let attempt = 0; attempt < 2; attempt++) {
            const grown = await CartModel.findOneAndUpdate(
                { _id: cartId, tableId, status: "open", split: { $elemMatch: mine }, ...fits },
                { $inc: { "split.$.qty": qty } }
            ).populate(menuRef("split.menuId")).populate(menuRef("items.menuId"))
            if (grown) return res.send(forDiner(grown, req))

            const started = await CartModel.findOneAndUpdate(
                { _id: cartId, tableId, status: "open", split: { $not: { $elemMatch: mine } }, ...fits },
                { $push: { split: { userId: user._id, menuId: menuOid, qty, claimedAt: new Date() } } }
            ).populate(menuRef("split.menuId")).populate(menuRef("items.menuId"))
            if (started) return res.send(forDiner(started, req))
        }

        return next(createError(409, "Not enough units left to split"))
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

        const isItemThere = await CartModel.findOne({_id: cartId, tableId: req.params.tableId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } })

        if (isItemThere) {
            const decreasedItem = await CartModel.findOneAndUpdate({_id: cartId, tableId: req.params.tableId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $inc: { "split.$.qty": -(1) }}).populate(menuRef("split.menuId")).populate(menuRef("items.menuId"))

            const removedItem = await CartModel.findOneAndUpdate({_id: cartId, tableId: req.params.tableId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $pull: { split: { qty: { $lte: 0 } }}}).populate(menuRef("split.menuId")).populate(menuRef("items.menuId"))
            
            if (removedItem) {
                res.send(forDiner(removedItem, req))
            } else {
                res.send(forDiner(decreasedItem, req))
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

        const isItemThere = await CartModel.findOne({_id: cartId, tableId: req.params.tableId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } })

        if (isItemThere) {
            const decreasedItem = await CartModel.findOneAndUpdate({_id: cartId, tableId: req.params.tableId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $set: { "split.$.qty": 0 }}).populate(menuRef("split.menuId")).populate(menuRef("items.menuId"))

            const removedItem = await CartModel.findOneAndUpdate({_id: cartId, tableId: req.params.tableId, split: { $elemMatch: {userId: user._id, menuId: splitItem.menuId, splitStatus: "open"} } }, { $pull: { split: { qty: { $lte: 0 } }}}).populate(menuRef("split.menuId")).populate(menuRef("items.menuId"))

            if (removedItem) {
                res.send(forDiner(removedItem, req))
            } else {
                res.send(forDiner(decreasedItem, req))
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
type PopulatedMenuRef = { _id: mongoose.Types.ObjectId; name: string; price: number; available?: boolean }

const menuIdOf = (ref: ISplitItem["menuId"]): string => {
    const populated = ref as unknown as PopulatedMenuRef
    return (populated._id ?? ref).toString()
}

// The cart must be the one of the table in the URL: a cart id is otherwise
// enough to act on any table's cart (a stale page after moving tables, or a
// tampered request).
const loadOpenCart = (cartId: string, tableId: string) =>
    CartModel.findOne({ _id: cartId, tableId, status: "open" })
        .populate(menuRef("split.menuId"))
        .populate(menuRef("items.menuId"))

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

// Sold-out items are not payable. Reads the populated menu (MENU_FIELDS carries
// `available`); a menu item deleted since it was split populates as menuRef's
// sold-out stand-in.
const soldOutError = (openSplits: ISplitItem[]): string | null =>
    openSplits.some((s) => {
        const menu = s.menuId as unknown as PopulatedMenuRef | null
        return !menu || menu.available === false
    })
        ? SOLD_OUT_CHECKOUT
        : null

// The PayPal order must be COMPLETED with its capture COMPLETED (or its capture
// PENDING: taken, held by PayPal for review), in GBP, for exactly the amount
// due. Returns a message on any mismatch, or null when it verifies.
const orderVerificationError = (order: PayPalOrder, expectedTotal: number): string | null => {
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0]
    if (
        !(capture?.status === "PENDING" || (order.status === "COMPLETED" && capture?.status === "COMPLETED")) ||
        capture?.amount?.currency_code !== "GBP" ||
        capture?.amount?.value !== expectedTotal.toFixed(2)
    ) {
        return "PayPal payment does not match the amount due"
    }
    return null
}

// Closes a cart whose every unit is paid, unless a payment on it is still
// pending: until it's confirmed, the table must keep showing it.
export const closeIfPaidOff = (cart: ICartDocument) => {
    if (cart.items.every((i) => i.qty <= i.qtyPayed) && !cart.payments.some((p) => p.status === "pending")) {
        cart.status = "closed"
    }
}

// Apply what a settlement does, in memory on the loaded doc, for a single
// version-checked save(): close the caller's open splits and credit qtyPayed,
// and record the payment. Prices are the populated menu's, the same ones
// expectedTotalFor charged and the capture was verified against; `order` is
// captureCheckout's own capture result. A PENDING capture is recorded as a
// pending payment: its units are held as paid, and the cart stays open until
// a manager checks it (checkPayment), so the table still shows it.
const applyCheckout = (
    cart: ICartDocument,
    openSplits: ISplitItem[],
    userId: mongoose.Types.ObjectId,
    paypalOrderId: string,
    order: PayPalOrder
) => {
    const paidAt = new Date()
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0]
    const lines = []
    for (const split of openSplits) {
        const menu = split.menuId as unknown as PopulatedMenuRef
        split.splitStatus = "closed"
        split.unitPrice = menu.price
        split.paidAt = paidAt
        lines.push({ menuId: menu._id, name: menu.name, qty: split.qty, unitPrice: menu.price, refundedQty: 0 })
        const item = cart.items.find((i) => menuIdOf(i.menuId) === menuIdOf(split.menuId))
        if (item) item.qtyPayed += split.qty
    }
    cart.payments.push({
        provider: "paypal",
        status: capture?.status === "PENDING" ? "pending" : "completed",
        providerCheckoutId: paypalOrderId,
        providerPaymentId: capture?.id,
        currency: capture?.amount?.currency_code ?? "GBP",
        userId,
        paidAt,
        amount: Number(capture?.amount?.value ?? expectedTotalFor(openSplits).toFixed(2)),
        lines,
    })
    if (!cart.paypalOrderIds) cart.paypalOrderIds = []
    cart.paypalOrderIds.push(paypalOrderId)
    closeIfPaidOff(cart)
}

// Outcome of a settlement attempt. Returned (not sent) so captureCheckout can
// refund the buyer before reporting a failure that happened after money moved.
type SettleOutcome =
    | { ok: true; cart: ICartDocument }
    | { ok: false; status: number; message: string }

// Apply + persist the settlement under optimistic concurrency. The cart is
// loaded afresh for every attempt, the first one too: the one captureCheckout
// loaded is from before the PayPal round trips, and any other diner's tap since
// would make saving it conflict. Each attempt re-derives everything from the
// fresh doc, re-checks replay/availability and re-verifies against the
// already-known (immutable) `order`; a concurrent write's VersionError means
// another attempt, a bounded number of times (running out refunds the payer, so
// there are enough for a busy table). `order` is captureCheckout's own capture
// result.
const settleCheckout = async (
    cartId: string,
    tableId: string,
    userId: mongoose.Types.ObjectId,
    paypalOrderId: string,
    order: PayPalOrder
): Promise<SettleOutcome> => {
    const MAX_ATTEMPTS = 5
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const cart = await loadOpenCart(cartId, tableId)
        if (!cart) return { ok: false, status: 404, message: "Cart Not Found!" }
        // Re-check replay too: a payer we conflicted with may have recorded
        // THIS very order id — on this same cart, where the unique index can't
        // help (duplicates within one document's array don't violate a
        // multikey unique index).
        const replayed = await CartModel.findOne({
            $or: [{ paypalOrderIds: paypalOrderId }, { paypalOrderId }],
        })
        if (replayed) return { ok: false, status: 402, message: "This PayPal order has already been used" }
        const openSplits = callerOpenSplits(cart, userId)
        if (openSplits.length === 0) return { ok: false, status: 404, message: "No open split items to pay!" }
        const availError = availabilityError(cart, openSplits)
        if (availError) return { ok: false, status: 409, message: availError }
        const verifyError = orderVerificationError(order, expectedTotalFor(openSplits))
        if (verifyError) return { ok: false, status: 402, message: verifyError }

        applyCheckout(cart, openSplits, userId, paypalOrderId, order)
        try {
            await cart.save()
            return { ok: true, cart }
        } catch (error) {
            const err = error as { code?: number; cause?: { code?: number }; name?: string }
            if (err.code === 11000 || err.cause?.code === 11000) {
                return { ok: false, status: 402, message: "This PayPal order has already been used" }
            }
            if (err.name !== "VersionError") throw error
        }
    }
    return { ok: false, status: 409, message: "Checkout conflicted with a concurrent payment, please retry" }
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

        const cart = await loadOpenCart(cartId, req.params.tableId)
        if (!cart) return next(createError(404, "Cart Not Found!"))

        const openSplits = callerOpenSplits(cart, user._id)
        if (openSplits.length === 0) return next(createError(404, "No open split items to pay!"))

        const availError = availabilityError(cart, openSplits)
        if (availError) return next(createError(409, availError))

        const soldOut = soldOutError(openSplits)
        if (soldOut) return next(createError(409, soldOut))

        const expectedTotal = expectedTotalFor(openSplits)

        try {
            const paypalOrderId = await createOrder(expectedTotal.toFixed(2), `${cartId}:${user._id}`)
            res.send({ paypalOrderId })
        } catch {
            // Shown to the diner as is (expose), not as "Generic Server Error".
            return next(createError(502, "Could not create PayPal order", { expose: true }))
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
        const cart = await loadOpenCart(cartId, req.params.tableId)
        if (!cart) return next(createError(404, "Cart Not Found!"))

        const openSplits = callerOpenSplits(cart, user._id)
        if (openSplits.length === 0) return next(createError(404, "No open split items to pay!"))

        // Sold-out check, still before any money moves: a buyer who approved in
        // the popup while the item sold out is rejected uncharged and the order
        // simply expires. Checked here rather than in (d) so a deleted menu item
        // (menuRef's sold-out stand-in) is never priced in (c). Deliberately
        // NOT re-checked in settleCheckout: an item that sells out in the instant
        // after capture has already been paid for, and is not refunded for that.
        const soldOut = soldOutError(openSplits)
        if (soldOut) return next(createError(409, soldOut))

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
        } catch (captureError) {
            if (captureError instanceof PayPalCaptureRefused) return next(createError(402, "PayPal capture failed"))
            // PayPal's answer doesn't say whether the buyer was charged, so
            // they must not be told to pay again: shown as is (expose), with
            // the order id for staff to look up.
            console.error("PayPal capture outcome unknown", { paypalOrderId, error: captureError })
            return next(createError(502,
                `We couldn't confirm your payment with PayPal — please contact staff before paying again (order ${paypalOrderId})`,
                { expose: true }))
        }

        const capture = captured.purchase_units?.[0]?.payments?.captures?.[0]
        // PENDING: taken, but held by PayPal for review. It settles like a
        // completed one, as a pending payment (see applyCheckout).
        const pending = capture?.status === "PENDING"
        if (!pending && (captured.status !== "COMPLETED" || capture?.status !== "COMPLETED")) {
            // Capture did not go through — no money moved, so no refund needed.
            return next(createError(402, "PayPal capture did not complete"))
        }
        const captureId = capture?.id

        // (f) Settle under optimistic concurrency, re-verifying against our own
        // capture result on any version conflict.
        // Any failure from here on happens AFTER the money moved, so it must
        // reach the refund below: a database error while saving is not an
        // excuse to keep the buyer's money with nothing recorded.
        let outcome: SettleOutcome
        try {
            outcome = await settleCheckout(cartId, req.params.tableId, user._id, paypalOrderId, captured)
        } catch (settleError) {
            console.error("Settling a captured PayPal payment failed", { paypalOrderId, error: settleError })
            outcome = { ok: false, status: 500, message: "The payment could not be recorded" }
        }
        // 202 for a pending payment: the diner's units are held, but PayPal
        // hasn't confirmed it yet.
        if (outcome.ok) return res.status(pending ? 202 : 200).send(forDiner(outcome.cart, req))

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
            // Shown to the diner as is (expose): staff need the order id.
            return next(createError(500, `Payment captured but could not be settled or refunded — please contact staff (order ${paypalOrderId})`, { expose: true }))
        }
        // 409 with REFUNDED_MARKER's wording either way: the FE tells the buyer
        // they've been refunded.
        return next(createError(409, outcome.status === 500
            ? "Your payment could not be recorded — your payment was refunded"
            : "The table's cart changed while you were paying — your payment was refunded"))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------