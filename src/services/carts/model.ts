import mongoose from "mongoose"
import { ICart, ICartDocument } from "src/typings/cart"

const { Schema, model } = mongoose

const CartSchema = new Schema<ICart>(
    {
        tableId: {
            type: String,
            required: true,
        },
        status: {
            type: String,
            enum: ["open", "closed"],
            default: "open",
        },
        items: [
            {
                item_id: {
                    type: Schema.Types.ObjectId,
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
                itemId: {
                    type: Schema.Types.ObjectId,
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