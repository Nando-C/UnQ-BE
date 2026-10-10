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
// Each side of it indexed: a card payment on an older cart finds its shop by
// its table (stripeControllers.ts).
ShopSchema.index({ "tables._id": 1 })
ShopSchema.index({ "deletedTables._id": 1 })

ShopSchema.methods.toJSON = function () {
    const shop = this.toObject()
    delete shop.__v
    return shop
}

const ShopModel = model<IShopDocument>("Shop", ShopSchema)
export default ShopModel

// The shop a table (current or deleted) belongs to, for a record that doesn't
// carry it; undefined once no shop has the table.
export const shopIdOfTable = async (tableId: string) => (await ShopModel.findOne(ofTable(tableId)).select("_id").lean())?._id
// A cart's shop: the one it records or, for a cart saved before carts did, its table's.
export const shopIdOfCart = async (cart: { shopId?: mongoose.Types.ObjectId; tableId: string }) => cart.shopId ?? shopIdOfTable(cart.tableId)