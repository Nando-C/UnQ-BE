import { TController } from "src/typings/controllers"
import ShopModel from "./model"
import createError from "http-errors"
import { IUserDocument } from "src/typings/users"

export const createShop: TController = async ( req, res, next ) => {
    try {
    const user = req.user as IUserDocument

    const newShop = { 
        ...req.body, 
        shopMg: [ user._id ],
        cover: `https://nayemdevs.com/wp-content/uploads/2020/03/default-product-image.png`,
    }

        const shop = await new ShopModel(newShop).save()
        res.send(shop)
    } catch (error) {
        next(createError(400, error as Error))
    }
}