import mongoose, { Types } from "mongoose"
import { IShopDocument, MemberRole } from "src/typings/shop"

const { Schema, model } = mongoose

// The roles a member can hold today: the owner (one per shop) and managers.
export const MEMBER_ROLES: readonly MemberRole[] = ["owner", "manager"]

import { DEFAULT_TIME_ZONE, canonicalTimeZone } from "../../lib/days"

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
        // The zone the shop's days are counted in (an IANA name): the sales
        // report's buckets and ranges. Shops saved before it existed read as
        // the default.
        timeZone: {
            type: String,
            default: DEFAULT_TIME_ZONE,
            // Saved under its canonical name, whatever spelling was sent.
            set: (name: string) => canonicalTimeZone(name) ?? name,
        },
        // Every account with access, owner included: what the guards read.
        // Changed only together with `members`, in the same update.
        shopMg: {
            type: [Schema.Types.ObjectId],
            required: true,
            ref: "User",
        },
        // The one member who can delete the shop. Shops saved before membership
        // existed get it, and `members`, from `shopMg` the first time a member
        // or an administrator opens them (membershipOf below).
        ownerId: { type: Schema.Types.ObjectId, ref: "User" },
        members: {
            type: [
                {
                    _id: false,
                    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
                    role: { type: String, enum: MEMBER_ROLES, required: true },
                    since: { type: Date, required: true },
                    addedBy: { type: Schema.Types.ObjectId, ref: "User" },
                },
            ],
            default: [],
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

// A manager's shops (/shops/me, and deleting their account). `members.userId`
// holds the same ids, so it needs no index of its own.
ShopSchema.index({ shopMg: 1 })
// The shops an account owns (deleting the account, changing its role).
ShopSchema.index({ ownerId: 1 })

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

// What the guards and /shops/me read of a shop: its membership.
const MEMBERSHIP = "shopMg ownerId members createdAt"
export type ShopMembership = Pick<IShopDocument, "_id" | "shopMg" | "ownerId" | "members">

// A shop's membership, filled first if the shop is from before membership
// existed (`shopMg` and no `ownerId`): its first id becomes the owner and any
// others managers, since the shop was made. The fill is one update, conditioned
// on `ownerId` being absent and computed from the stored array (a pipeline), so
// two fills at once land once, a fill never overwrites a staff write (every
// staff write requires `ownerId`, so it can only follow a fill), and no stale
// read is written back. Called by the guards and /shops/me, never by a public
// read, which stays a read. Null for a shop that isn't there.
export const membershipOf = async (shopId: Types.ObjectId | string): Promise<ShopMembership | null> => {
    const filled = await ShopModel.findOneAndUpdate(
        { _id: shopId, ownerId: { $exists: false }, "shopMg.0": { $exists: true } },
        [{ $set: { ownerId: { $arrayElemAt: ["$shopMg", 0] }, members: { $map: { input: "$shopMg", as: "id", in: {
            userId: "$$id",
            role: { $cond: [{ $eq: ["$$id", { $arrayElemAt: ["$shopMg", 0] }] }, "owner", "manager"] },
            since: { $ifNull: ["$createdAt", "$$NOW"] },
        } } } } }],
        // Mongoose 9 asks for the pipeline to be spelled out.
        { updatePipeline: true },
    ).select(MEMBERSHIP)
    // Already filled (or filled by the other request a moment ago): read it.
    return filled ?? ShopModel.findById(shopId).select(MEMBERSHIP)
}

// The shops an account owns, in both shapes: filled, or not yet (then the
// first manager is the owner-to-be).
export const ownedBy = (userId: Types.ObjectId | string) => ({
    $or: [{ ownerId: userId }, { ownerId: { $exists: false }, "shopMg.0": userId }],
})

// The shop a table (current or deleted) belongs to, for a record that doesn't
// carry it; undefined once no shop has the table.
export const shopIdOfTable = async (tableId: string) => (await ShopModel.findOne(ofTable(tableId)).select("_id").lean())?._id
// A cart's shop: the one it records or, for a cart saved before carts did, its table's.
export const shopIdOfCart = async (cart: { shopId?: mongoose.Types.ObjectId; tableId: string }) => cart.shopId ?? shopIdOfTable(cart.tableId)