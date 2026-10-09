import { TController } from "src/typings/controllers"
import createError from "http-errors"
import { verifyJWT } from "./tools"
import { JwtPayload } from "jsonwebtoken"
import UserModel from "../users/model"
import ShopModel from "../shops/model"
import { IUserDocument } from "src/typings/users"


// -------------------------------------------------------------------------

// For routes open to everyone that show more to a signed-in user: sets req.user
// when the access token is valid, and carries on as a guest without one (or
// when its user is gone). An expired or invalid token gets a 401, like on the
// signed-in routes, so the FE refreshes it and asks again rather than quietly
// showing a signed-in diner the guest view. A failed refresh clears the cookies,
// so the request after it is a guest's.
export const optionalJWT: TController = async (req, res, next) => {
    const token = req.cookies.accessToken
    if (!token) return next()
    let decodedToken: JwtPayload
    try {
        decodedToken = (await verifyJWT(token)) as JwtPayload
    } catch {
        return next(createError(401, "Invalid token"))
    }
    try {
        const user = await UserModel.findById(decodedToken._id)
        if (user) req.user = user
        next()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

// For signed-in routes: sets req.user from the access-token cookie, or 401
// (the FE then refreshes the token and retries).
export const JWTAuthMiddleware: TController = async (req, res, next) => {
    if (!req.cookies.accessToken) return next(createError(401, "Please provide credentials in cookies!"))
    const token = req.cookies.accessToken
    try {
        const decodedToken = (await verifyJWT(token)) as JwtPayload
        const user = await UserModel.findById(decodedToken._id)
        if (!user) return next(createError(404, "User not found!"))
        req.user = user
        next()
    } catch {
        next(createError(401, "Invalid token"))
    }
}

// -------------------------------------------------------------------------

// After JWTAuthMiddleware: the user has the shop-manager role (any shop).
export const adminOnly: TController = async ( req, res, next ) => {
    const user = req.user as IUserDocument

    if (user.role === "shopMg") {
        next()
    } else {
        next(createError(403, "Shop Manager Only!!"))
    }
}

// -------------------------------------------------------------------------

// After JWTAuthMiddleware: the user manages the shop in :shopId (404 if
// there's no such shop).
export const isShopManager: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const shopId = req.params.shopId

        const myShop = await ShopModel.findById(shopId).select("shopMg")

        if (myShop) {
            if ( myShop.shopMg.some((managerId) => managerId.equals(String(user._id)))){
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

// -------------------------------------------------------------------------