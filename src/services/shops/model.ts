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
            required: false
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
        storeMg: {
            type: [Schema.Types.ObjectId],
            ref: "User",
            required: true,
        },
        tables: [
            {
                tableId: String,
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
                    required: false,
                },
                short_decription: {
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