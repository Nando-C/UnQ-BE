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
        // Text, as typed ("0161 496 0000"): a number would drop the leading 0.
        // Shops saved before it was text hold a number; Mongoose reads it as
        // text. "" clears it.
        phone: {
            type: String,
            required: false,
        },
        web_URL: {
            type: String,
            required: false,
        },
        shopMg: {
            type: [Schema.Types.ObjectId],
            required: true,
            ref: "User",
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
        // Tables the manager deleted, kept (by their ids) so the carts closed at
        // them stay reachable from the manager's page; they take no orders.
        deletedTables: [
            {
                name: {
                    type: String,
                    required: true,
                },
                deletedAt: {
                    type: Date,
                    required: true,
                },
            },
        ],
        menu:
            {
                type: [Schema.Types.ObjectId],
                required: true,
                ref: "Menu",
            },
    },
    { timestamps: true }
)

// A manager's shops (/shops/me, and deleting their account).
ShopSchema.index({ shopMg: 1 })

// A filter for the shop with this table, current or deleted (for carts saved
// before they recorded their shop).
export const ofTable = (tableId: string) => ({ $or: [{ "tables._id": tableId }, { "deletedTables._id": tableId }] })

ShopSchema.methods.toJSON = function () {
    const shop = this.toObject()
    delete shop.__v
    return shop
}

export default model<IShopDocument>("Shop", ShopSchema)