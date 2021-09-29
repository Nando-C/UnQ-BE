import { TController } from "src/typings/controllers"
import createError from "http-errors"
import { verifyJWT } from "./tools"
import { JwtPayload } from "jsonwebtoken"
import UserModel from "../users/model"
import ShopModel from "../shops/model"
import { IUserDocument } from "src/typings/users"


export const JWTAuthMiddleware: TController = async (req, res, next) => {
    if (!req.cookies.accessToken) return next(createError(401, "Please provide credentials in cookies!"))
    const token = req.cookies.accessToken
    try {
        const decodedToken = (await verifyJWT(token)) as JwtPayload
        const user = await UserModel.findById(decodedToken._id)
        if (!user) return next(createError(404, "User not found!"))
        req.user = user
        next()
    } catch (error) {
        next(createError(401, "Invalid token"))
    }
}

export const adminOnly: TController = async ( req, res, next ) => {
    const user = req.user as IUserDocument

    if (user.role === "shopMg") {
        next()
    } else {
        next(createError(403, "Shop Manager Only!!"))
    }
}

export const isShopManager: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const shopId = req.params.shopId

        const myShop = await ShopModel.findById(shopId)

        if (myShop) {
            if ( myShop.shopMg.includes(user._id)){
                next()
            } else {
                next(createError(403, `Shop Manager Only!`))
            }
        } else {
            next(createError(404, `Shop Not Found!`))
        }
    } catch (error) {
        next(error)
    }
}