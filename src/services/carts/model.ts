import mongoose, { UpdateQuery } from "mongoose"
import { ICartDocument, INotice } from "src/typings/cart"

const { Schema, model } = mongoose

// A table's order. Each table has at most one OPEN cart, shared by everyone
// sitting there: whoever orders first creates it, the others add to it.
// - items: what the table ordered, one line per menu item (qty ordered, qtyPayed
//   paid for).
// - split: who pays for what. A diner selects units of a line to pay for (an
//   "open" split); checkout pays for all of their open splits at once and marks
//   them "closed". Units in someone's open split are held for them.
// - payments / refunds / managerLog: manager-only records (see dinerView).
// The cart closes once every unit is paid, or when a manager closes it; the
// next party at the table then starts a new one.
const CartSchema = new Schema<ICartDocument>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            required: true,
            ref: "User",
        },
        shopId: {
            type: Schema.Types.ObjectId,
            ref: "Shop",
        },
        tableId: {
            type: String,
            required: true,
        },
        // "splitted" is a legacy value: nothing sets it any more.
        status: {
            type: String,
            enum: ["open", "splitted", "closed"],
            default: "open",
        },
        items: [
            {
                menuId: {
                    type: Schema.Types.ObjectId,
                    required: true,
                    ref: "Menu",
                },
                qty: {
                    type: Number,
                    required: true,
                },
                qtyPayed: {
                    type: Number,
                    default: 0,
                },
            }
        ],
        // Legacy scalar: the single PayPal order that settled this cart. Kept so
        // carts settled before multi-payer support can still be read and replay-
        // checked, but NEVER written any more (a shared cart can have many payers).
        paypalOrderId: {
            type: String,
        },
        // Every PayPal order that has settled part of this cart — one per payer.
        // The unique+sparse multikey index enforces cross-document uniqueness, so
        // an order id can never be replayed to settle a second checkout (the
        // save fails with 11000). Within-document duplicates are prevented by
        // the controller's replay pre-check.
        //
        // `default: undefined` is REQUIRED: a mongoose array otherwise defaults to
        // `[]`, and an empty array is indexed as the key `undefined` which a sparse
        // index does NOT skip — so every unsettled cart would collide on that key
        // and fail to insert. Leaving the field absent until first settlement lets
        // sparse skip it, and the controller lazily initialises it before pushing.
        paypalOrderIds: {
            type: [String],
            unique: true,
            sparse: true,
            default: undefined,
        },
        split: [
            {
                userId: {
                    type: Schema.Types.ObjectId,
                    required: true,
                },
                menuId: {
                    type: Schema.Types.ObjectId,
                    ref: "Menu",
                    required: true,
                },
                qty: {
                    type: Number,
                    required: true,
                },
                splitStatus: {
                    type: String,
                    enum: ["open", "closed"],
                    default: "open",
                },
                // Set when the split is paid: the price each unit was charged
                // at, and when. "Total Payed" reads these, so a later menu price
                // edit doesn't change what the cart says was paid. Legacy paid
                // splits have neither.
                unitPrice: Number,
                paidAt: Date,
                // When the diner first selected it (not moved by later +/-), so
                // a manager can see a selection held for a long time. Legacy
                // selections have none.
                claimedAt: Date,
            }
        ],
        // One record per settled checkout, written in the same save that settles
        // it: who took the money and their ids for it, the payer, when, the
        // amount, and each line at the price charged. `refundedQty` counts the
        // units of a line refunded since. Manager-only: toJSON strips it, so it
        // never reaches a diner (the table's cart is public). Manager endpoints
        // read it from toObject().
        //
        // Provider-neutral, so another payment provider (e.g. Stripe) records
        // into the same shape:
        // - providerCheckoutId: what the checkout was keyed on. PayPal: the
        //   order id. (Stripe: the PaymentIntent or Checkout Session id.)
        // - providerPaymentId: the money movement a refund is made against.
        //   PayPal: the capture id. (Stripe: the PaymentIntent or charge id.)
        //   Missing only if the provider's result had no id, which must not
        //   stop the payment being recorded; it can then only be refunded from
        //   the provider's dashboard.
        // - status: `pending` when the provider took the money but hasn't
        //   confirmed it (PayPal holds some captures for review). Its units are
        //   held as paid, the cart stays open, and it can't be refunded, until a
        //   manager checks it (checkPayment): `completed`, or `failed`, which
        //   makes its units unpaid again. Payments recorded before it existed
        //   read as `completed`.
        payments: [
            {
                provider: { type: String, enum: ["paypal"], required: true },
                status: { type: String, enum: ["completed", "pending", "failed"], default: "completed" },
                providerCheckoutId: { type: String, required: true },
                providerPaymentId: String,
                currency: { type: String, required: true },
                userId: { type: Schema.Types.ObjectId, required: true },
                paidAt: { type: Date, required: true },
                amount: { type: Number, required: true },
                lines: [
                    {
                        _id: false,
                        menuId: { type: Schema.Types.ObjectId, required: true },
                        name: { type: String, required: true },
                        qty: { type: Number, required: true },
                        unitPrice: { type: Number, required: true },
                        refundedQty: { type: Number, default: 0 },
                    }
                ],
            }
        ],
        // Refunds a manager made against the payments above. Written as
        // `pending` BEFORE the provider is asked (pending units count as
        // refunded, so the same units can't be refunded twice), then
        // `completed` with the provider's refund id, or `failed` with its reason.
        // One left `pending` means the provider was asked but the answer wasn't
        // recorded: check the provider before doing anything else. Manager-only.
        refunds: [
            {
                paymentId: { type: Schema.Types.ObjectId, required: true },
                lines: [
                    {
                        _id: false,
                        menuId: { type: Schema.Types.ObjectId, required: true },
                        name: { type: String, required: true },
                        qty: { type: Number, required: true },
                    }
                ],
                amount: { type: Number, required: true },
                currency: { type: String, required: true },
                status: { type: String, enum: ["pending", "completed", "failed"], required: true },
                providerRefundId: String,
                failureReason: String,
                byUserId: { type: Schema.Types.ObjectId, required: true },
                at: { type: Date, required: true },
            }
        ],
        // Notes to the table's diners when a manager changes their cart ("The
        // staff released your selection of 2× Latte"). Text only. One with a
        // `forUserId` is for that diner alone; one without is for the table.
        // Diners see recent ones only (see dinerView).
        notices: [
            {
                at: { type: Date, required: true },
                forUserId: Schema.Types.ObjectId,
                message: { type: String, required: true },
            }
        ],
        // What managers did to this cart, for the manager view. Manager-only.
        managerLog: [
            {
                _id: false,
                at: { type: Date, required: true },
                byUserId: { type: Schema.Types.ObjectId, required: true },
                action: { type: String, required: true },
                details: String,
            }
        ],
    },
    // Optimistic concurrency: every save() is version-checked on ANY modified
    // path (Mongoose's default versioning only guards array-structure changes,
    // not the subpath $sets a settlement performs). Checkout, deleteItem, the
    // refunds and the manager actions load, change and save(); a save that meets
    // a newer version throws VersionError and retries or answers 409.
    { timestamps: true, optimisticConcurrency: true }
)

// Every direct update bumps the version too. Mongoose only does that in save(),
// so an addItem or an untick (findOneAndUpdate) would change a cart without it,
// and a save() that loaded the cart before would pass its check and write over
// the change: by array position, so onto someone else's selection.
CartSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function () {
    const update = this.getUpdate()
    if (!update || Array.isArray(update)) return
    const inc = ((update as UpdateQuery<ICartDocument>).$inc ??= {}) as Record<string, number>
    if (!("__v" in inc)) inc.__v = 1
})

// One open cart per table: the database refuses a second one, so two diners
// placing a table's first order at the same moment can't each create a cart
// (addItem retries onto the one that won). Mongoose builds it at startup
// (index.ts reports a failure); it can't be built while a table already has two
// open carts — list them with src/scripts/findDuplicateOpenCarts.ts.
CartSchema.index({ tableId: 1 }, { unique: true, partialFilterExpression: { status: "open" } })

// How long a closed cart stays on its table's sheet, where a manager refunds
// it (refunds usually come after a table has finished). A shop with a paid
// cart still on a sheet can't be deleted yet.
export const RECENTLY_CLOSED_MS = 24 * 60 * 60 * 1000

// Carts with money PayPal hasn't confirmed: a payment it holds for review or a
// refund it didn't clearly answer. Only a manager can settle them (checkPayment,
// retryRefund), so they stay in reach and hold back deleting their table or shop.
export const AWAITING_PAYPAL = { $or: [{ "payments.status": "pending" as const }, { "refunds.status": "pending" as const }] }

// Diners see notices from the last 2 hours, at most the 5 newest.
export const NOTICE_MAX_AGE_MS = 2 * 60 * 60 * 1000
const NOTICE_MAX = 5

// The notices a viewer may see: recent ones, for everyone at the table or for
// them, newest first. Text only.
export const noticesFor = (notices: INotice[], viewerId?: unknown) => {
    const since = Date.now() - NOTICE_MAX_AGE_MS
    const viewer = viewerId ? String(viewerId) : null
    return notices
        .filter((n) =>
            n.at.getTime() >= since && (!n.forUserId || (viewer && String(n.forUserId) === viewer)))
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, NOTICE_MAX)
        .map((n) => ({ _id: n._id, at: n.at, message: n.message }))
}

// The id of a reference, populated (then the referenced document) or not.
export const refId = (ref: unknown) => String((ref as { _id?: unknown } | null)?._id ?? ref)

// Whether a diner took part in a cart: they started it, have a selection on
// it, or paid on it. Once the cart is closed, only they see its table-wide
// notices (a new party at the table doesn't).
export const tookPart = (cart: ICartDocument, userId: unknown) => {
    const id = String(userId)
    return String(cart.userId) === id ||
        cart.split.some((s) => String(s.userId) === id) ||
        cart.payments.some((p) => String(p.userId) === id)
}

// A cart as a diner may see it. The table's cart is public (no login), so the
// payment and refund records and the manager log never leave the server this
// way, and of the notices only the table-wide ones do, plus those meant for
// `viewerId` when the caller is known. Manager endpoints use toObject() instead.
export const dinerView = (cart: ICartDocument, viewerId?: unknown) => {
    const view = cart.toObject()
    delete view.__v
    delete view.payments
    delete view.refunds
    delete view.managerLog
    view.notices = noticesFor(view.notices ?? [], viewerId)
    return view
}

// What res.send(cart) sends: the public diner view (controllers that know the
// caller use dinerView with their id, to include that diner's own notices).
CartSchema.methods.toJSON = function () {
    return dinerView(this as ICartDocument)
}

export default model<ICartDocument>("Cart", CartSchema)