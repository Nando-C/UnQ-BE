import mongoose from "mongoose"
import { IShopDocument } from "src/typings/shop"

const { Schema, model } = mongoose 

const ShopSchema = new Schema<IShopDocument> (
    {
        name: {
            type: String,
            required: true,
        },
        cover: {
            type: String,
            default: `https://nayemdevs.com/wp-content/uploads/2020/03/default-product-image.png`,
        },
        bio: {
            type: String,
            required: false,
        },
        open_times: {
            type: String,
            required: false,
        },
        phone: {
            type: Number,
            required: false,
        },
        web_URL: {
            type: String,
            required: false,
        },
        shopMg: {
            type: [Schema.Types.ObjectId],
            ref: "User",
            required: true,
        },
        tables: [
            {
                name: {
                    type: String,
                    required: true,
                },
                Qr_Url: String,
            },
        ],
        menu: [
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
            }
        ],
    },
    { timestamps: true }
)

ShopSchema.methods.toJSON = function () {
    const shop = this.toObject()
    delete shop.__v
    return shop
}

export default model<IShopDocument>("Shop", ShopSchema)