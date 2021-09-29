import mongoose from "mongoose"
import { ICart, ICartDocument } from "src/typings/cart"

const { Schema, model } = mongoose

const CartSchema = new Schema<ICart>(
    {
        shopId: {
            type: Schema.Types.ObjectId,
            ref: "Shop",
            required: true,
        },
        tableId: {
            type: String,
            required: true,
        },
        status: {
            type: String,
            enum: ["open", "splited", "closed"],
            default: "open",
        },
        items: [
            {
                menuId: {
                    type: Schema.Types.ObjectId,
                    ref: "Menu",
                    required: true,
                },
                qty: {
                    type: Number,
                    required: true,
                },
                // totalPriceItems: Number,
            }
        ],
        split: [
            {
                userId: {
                    type: Schema.Types.ObjectId,
                    // required: true,
                },
                menuId: {
                    type: Schema.Types.ObjectId,
                    ref: "Menu",
                    // required: true,
                },
                qty: {
                    type: Number,
                    // required: true,
                },
                splitStatus: {
                    type: String,
                    enum: ["open", "closed"],
                    default: "closed",
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