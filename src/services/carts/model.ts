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
        // Records the PayPal order that settled this cart's split checkout. Kept
        // unique so an order id can never be replayed to mark items paid twice.
        paypalOrderId: {
            type: String,
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
    { timestamps: true}
)

CartSchema.methods.toJSON = function () {
    const cart = this.toObject()
    delete cart.__v
    return cart
}

export default model<ICartDocument>("Cart", CartSchema)