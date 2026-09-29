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

        const existingTableName = await ShopModel.findOne( {_id: shopId, "tables.name": newTable.name} )
         if (existingTableName) return next(createError(400, `Table name: '${newTable.name}' already exist!`))

        const _id = new mongoose.Types.ObjectId()
        const Qr_Url = `${env.FRONTEND_ORIGIN}/shops/${shopId}/tables/${_id}`

        const modifiedShop = await ShopModel.findByIdAndUpdate(
            shopId,
            { $push: { tables: { _id, name: newTable.name, Qr_Url } } },
            { runValidators: true }
        )
        if (!modifiedShop) return next(createError(404, "Shop Not Found!"))

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

        // Same rule as createTable: two tables of one name have QR codes and
        // status cards that can't be told apart.
        const sameName = await ShopModel.findOne({ _id: shopId, tables: { $elemMatch: { name: modification.name, _id: { $ne: tableId } } } })
        if (sameName) return next(createError(400, `Table name: '${modification.name}' already exist!`))

        const modifiedShop = await ShopModel.findOneAndUpdate(
            { _id: shopId, tables: { $elemMatch: {_id: tableId} } },
            { $set: { "tables.$.name": modification.name } },
            { runValidators: true }
        )
        if (!modifiedShop) return next(createError(404, "Table Not Found!"))

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

        const modifiedShop = await ShopModel.findByIdAndUpdate(shopId, { $pull: { tables: { _id: tableId} } })
        if (!modifiedShop) return next(createError(404, "Table Not Found!"))

        res.status(204).send()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------