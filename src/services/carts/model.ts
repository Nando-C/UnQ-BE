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
            }
        ],
    },
    // Optimistic concurrency: every save() is version-checked on ANY modified
    // path (Mongoose's default versioning only guards array-structure changes,
    // not the subpath $sets checkOutSplit performs). The sole save() call site on
    // carts is checkOutSplit, so this closes the multi-payer lost-update hole
    // there without affecting the findOneAndUpdate-based item/split endpoints.
    { timestamps: true, optimisticConcurrency: true }
)

CartSchema.methods.toJSON = function () {
    const cart = this.toObject()
    delete cart.__v
    return cart
}

export default model<ICartDocument>("Cart", CartSchema)