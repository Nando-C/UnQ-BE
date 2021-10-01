import { TController } from "src/typings/controllers"
import { IUserDocument } from "src/typings/users"
import CartModel from "./model"
import createError from "http-errors"


export const createCart: TController = async ( req, res, next ) => {
    try {
    const user = req.user as IUserDocument
    // const shopId = req.params.shopId
    // const tableId = req.params.tableId

    const newCart = { 
        ...req.body, 
        userId: [ user._id ],
        // shopId: shopId,
        // tableId: tableId,
    }
        const cart = await new CartModel(newCart).save()
        res.send(cart)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

export const getMyCarts: TController = async ( req, res, next) => {
    try {
        const user = req.user as IUserDocument

        const myCarts = await CartModel.find({ userId: user._id })
            .populate({
                path: "items",
                populate: {
                    path: "menuId",
                    select: { _id: 0, name: 1 }
                }
            })
        if (!myCarts) return next(createError(404, "Carts Not Found!"))

        res.send(myCarts)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

export const getMySingleCart: TController = async ( req, res, next ) => {
    try {
        // const user = req.user as IUserDocument

        const myCart = await CartModel.findById(req.params.cartId)
        if (!myCart) return next(createError(404, `Cart Not Found!`))
        
        res.send(myCart)
    } catch (error) {
        next(createError(500, error as Error))
    }
}