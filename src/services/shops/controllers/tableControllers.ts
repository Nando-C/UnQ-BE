import { TController } from "../../../typings/controllers"
import ShopModel from "../model"
import createError from "http-errors"

// -------------------------------------------------------------------------

export const createTable: TController = async ( req, res, next ) => {
    try {
        const shopId = req.params.shopId
        const newTable = req.body

        const existingTableName = await ShopModel.findOne( {_id: shopId, "tables.name": newTable.name} )
         if (existingTableName) return next(createError(400, `Table name: '${newTable.name}' already exist!`))

        const modifiedShop = await ShopModel.findByIdAndUpdate({_id: shopId}, { $push: {tables: newTable}}, { runValidators: true})
        if (!modifiedShop) return next(createError(404, "Shop Not Found!"))

        const tableId = modifiedShop.tables[modifiedShop.tables.length-1]._id

        const modifiedShopWithQr = await ShopModel.findOneAndUpdate(
            { _id: shopId, "tables.name": newTable.name },
            { $set: {"tables.$.Qr_Url": `${process.env.FRONTEND_DEV_URL}/shops/${shopId}/tables/${tableId}`}},
            { runValidators: true }
        )

        res.send(modifiedShopWithQr.tables[modifiedShopWithQr.tables.length-1])
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
        if (!shopTables) return next(createError(404, "Table Not Found!"))

        res.send(shopTables.tables[0])
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

        const modifiedShop = await ShopModel.findOneAndUpdate(
            { _id: shopId, tables: { $elemMatch: {_id: tableId} } },
            { $set: { "tables.$": modification } },
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

        const modifiedShop = await ShopModel.findByIdAndUpdate(shopId, { $pull: { tables: { _id: tableId} } })
        if (!modifiedShop) return next(createError(404, "Table Not Found!"))

        res.status(204).send()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------