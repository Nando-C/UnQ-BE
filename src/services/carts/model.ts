import mongoose from "mongoose"
import { ICartDocument } from "src/typings/cart"

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
        payments: [
            {
                provider: { type: String, enum: ["paypal"], required: true },
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
    },
    // Optimistic concurrency: every save() is version-checked on ANY modified
    // path (Mongoose's default versioning only guards array-structure changes,
    // not the subpath $sets a settlement performs). The sole save() call site on
    // carts is captureCheckout, so this closes the multi-payer lost-update hole
    // there without affecting the findOneAndUpdate-based item/split endpoints.
    { timestamps: true, optimisticConcurrency: true }
)

// One open cart per table: the database refuses a second one, so two diners
// placing a table's first order at the same moment can't each create a cart
// (addItem retries onto the one that won). Mongoose builds it at startup
// (index.ts reports a failure); it can't be built while a table already has two
// open carts — list them with src/scripts/findDuplicateOpenCarts.ts.
CartSchema.index({ tableId: 1 }, { unique: true, partialFilterExpression: { status: "open" } })

CartSchema.methods.toJSON = function () {
    const cart = this.toObject()
    delete cart.__v
    delete cart.payments
    return cart
}

export default model<ICartDocument>("Cart", CartSchema)