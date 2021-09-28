import mongoose from "mongoose"
import { ICart } from "src/typings/cart"

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
                    default: "open",
                },
            }
        ]

    }
)