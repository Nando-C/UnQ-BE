import mongoose from "mongoose"
import { TController } from "../../../typings/controllers"
import ShopModel from "../model"
import createError from "http-errors"
import CartModel from "../../carts/model"
import env from "../../../settings/env"

// -------------------------------------------------------------------------

export const createTable: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId
        const newTable = req.body

        const _id = new mongoose.Types.ObjectId()
        const Qr_Url = `${env.FRONTEND_ORIGIN}/shops/${shopId}/tables/${_id}`

        // The name check is part of the update, so two requests at once (a
        // double tap) can't both pass it and add two tables of one name.
        const modifiedShop = await ShopModel.findOneAndUpdate(
            { _id: shopId, "tables.name": { $ne: newTable.name } },
            { $push: { tables: { _id, name: newTable.name, Qr_Url } } },
            { runValidators: true }
        )
        if (!modifiedShop) {
            if (!(await ShopModel.exists({ _id: shopId }))) return next(createError(404, "Shop Not Found!"))
            return next(createError(400, `Table name: '${newTable.name}' already exist!`))
        }

        res.send({ _id, name: newTable.name, Qr_Url })
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const getTableList: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId

        const shopTableList = await ShopModel.findById(shopId)
        if (!shopTableList) return next(createError(404, "Shop Not Found!"))

        res.send(shopTableList.tables)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const getSingleTable: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId
        const tableId = req.params.tableId

        const shopTables = await ShopModel.findById(shopId, { tables: { $elemMatch: {_id: tableId}} } )
        // No such shop, or no such table in it (deleted, or another shop's):
        // the projection then leaves `tables` empty.
        const table = shopTables?.tables[0]
        if (!table) return next(createError(404, "Table Not Found!"))

        res.send(table)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const editTable: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId
        const tableId = req.params.tableId
        const modification = req.body
        if (!mongoose.isValidObjectId(tableId)) return next(createError(404, "Table Not Found!"))
        const tableOid = new mongoose.Types.ObjectId(tableId)

        // Same rule as createTable: two tables of one name have QR codes and
        // status cards that can't be told apart. The check is part of the
        // update, so a rename racing a create or another rename can't pass it
        // too. The table is picked by an array filter, not the positional $,
        // which a second condition on `tables` would make ambiguous.
        const modifiedShop = await ShopModel.findOneAndUpdate(
            {
                _id: shopId,
                "tables._id": tableOid,
                tables: { $not: { $elemMatch: { name: modification.name, _id: { $ne: tableOid } } } },
            },
            { $set: { "tables.$[table].name": modification.name } },
            { runValidators: true, arrayFilters: [{ "table._id": tableOid }] }
        )
        if (!modifiedShop) {
            const tableExists = await ShopModel.exists({ _id: shopId, "tables._id": tableOid })
            if (!tableExists) return next(createError(404, "Table Not Found!"))
            return next(createError(400, `Table name: '${modification.name}' already exist!`))
        }

        res.send(modifiedShop.tables)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const deleteTable: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId
        const tableId = req.params.tableId

        // A table with an open cart would leave that cart unreachable: the
        // manager closes it first (POST …/carts/:cartId/close).
        if (await CartModel.exists({ tableId, status: "open" })) {
            return next(createError(409, "This table has an open cart — close it first"))
        }
        if (!mongoose.isValidObjectId(tableId)) return next(createError(404, "Table Not Found!"))

        const shop = await ShopModel.findById(shopId, { tables: { $elemMatch: { _id: tableId } } })
        if (!shop) return next(createError(404, "Table Not Found!"))
        // Already deleted (a second tap): nothing left to do.
        const table = shop.tables[0]
        if (!table) return res.status(204).send()

        // Moved to the shop's deleted tables rather than dropped: it takes no
        // orders and diners don't see it, but the manager can still open its
        // recent carts, to refund them. Only as it was read (not renamed since).
        const moved = await ShopModel.updateOne(
            { _id: shopId, tables: { $elemMatch: { _id: table._id, name: table.name } } },
            {
                $pull: { tables: { _id: table._id } },
                $push: { deletedTables: { _id: table._id, name: table.name, deletedAt: new Date() } },
            }
        )
        if (moved.modifiedCount !== 1) return next(createError(409, "The table changed, please try again"))

        res.status(204).send()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------