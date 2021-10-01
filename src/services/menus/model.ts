import mongoose from "mongoose"
import { IMenuDocument } from "src/typings/menu"

const { Schema, model } = mongoose

export const MenuSchema = new Schema<IMenuDocument>(
    {
        name: {
            type: String,
            required: true,
        },
        image: {
            type: String,
            default: `https://nayemdevs.com/wp-content/uploads/2020/03/default-product-image.png`,
        },
        short_description: {
            type: String,
            required: true,
        },
        description: {
            type: String,
            required: false,
        },
        price: {
            type: Number,
            required: true,
        },
        available: {
            type: Boolean,
            default: true,
        },
        category: {
            type: String,
            enum: ["food", "drinks"],
            required: true
        },
    },
    { timestamps: true }
)
export default model<IMenuDocument>("Menu", MenuSchema)