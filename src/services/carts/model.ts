import mongoose, { UpdateQuery } from "mongoose"
import { ICartDocument, INotice } from "src/typings/cart"

const { Schema, model } = mongoose

const CartSchema = new Schema<ICartDocument>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            required: true,
            ref: "User",
        },
        shopId: {
            type: Schema.Types.ObjectId,
            // required: true,
            ref: "Shop",
        },
        tableId: {
            type: String,
            required: true,
        },
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
                // PriceItems: Number,
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
        // an order id can never be replayed to settle a second checkout (S15's
        // 11000 backstop, now per-payer). Within-document duplicates are prevented
        // by the controller's replay pre-check.
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

// Diners see notices from the last 2 hours, at most the 5 newest.
const NOTICE_MAX_AGE_MS = 2 * 60 * 60 * 1000
const NOTICE_MAX = 5

// A cart as a diner may see it. The table's cart is public (no login), so the
// payment and refund records and the manager log never leave the server this way, and of
// the notices only the table-wide ones do, plus those meant for `viewerId`
// when the caller is known. Manager endpoints use toObject() instead.
export const dinerView = (cart: ICartDocument, viewerId?: unknown) => {
    const view = cart.toObject()
    delete view.__v
    delete view.payments
    delete view.refunds
    delete view.managerLog
    const since = Date.now() - NOTICE_MAX_AGE_MS
    const viewer = viewerId ? String(viewerId) : null
    view.notices = (view.notices ?? [])
        .filter((n: INotice) =>
            n.at.getTime() >= since && (!n.forUserId || (viewer && String(n.forUserId) === viewer)))
        .sort((a: INotice, b: INotice) => b.at.getTime() - a.at.getTime())
        .slice(0, NOTICE_MAX)
        .map((n: INotice) => ({ _id: n._id, at: n.at, message: n.message }))
    return view
}

// What res.send(cart) sends: the public diner view (controllers that know the
// caller use dinerView with their id, to include that diner's own notices).
CartSchema.methods.toJSON = function () {
    return dinerView(this as ICartDocument)
}

export default model<ICartDocument>("Cart", CartSchema)