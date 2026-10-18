import { TController } from "src/typings/controllers"
import createError from "http-errors"
import { verifyJWT } from "./tools"
import { JwtPayload } from "jsonwebtoken"
import UserModel, { isAdmin } from "../users/model"
import { membershipOf } from "../shops/model"
import { IUserDocument } from "src/typings/users"
import { Request } from "express"


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
        if (user) {
            req.user = user
            req.sessionId = decodedToken.sid
        }
        next()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

// For signed-in routes: sets req.user (and req.sessionId, the device's
// session) from the access-token cookie, or 401 (the FE then refreshes the
// token and retries).
export const JWTAuthMiddleware: TController = async (req, res, next) => {
    if (!req.cookies.accessToken) return next(createError(401, "Please provide credentials in cookies!"))
    const token = req.cookies.accessToken
    try {
        const decodedToken = (await verifyJWT(token)) as JwtPayload
        const user = await UserModel.findById(decodedToken._id)
        if (!user) return next(createError(404, "User not found!"))
        req.user = user
        req.sessionId = decodedToken.sid
        next()
    } catch {
        next(createError(401, "Invalid token"))
    }
}

// -------------------------------------------------------------------------

// After JWTAuthMiddleware: the user is an administrator (the account routes).
export const isAdministrator: TController = async ( req, res, next ) => {
    if (isAdmin(req.user as IUserDocument)) next()
    else next(createError(403, "Administrator only"))
}

// -------------------------------------------------------------------------

// After JWTAuthMiddleware: the user may create shops (the shop-manager role,
// or an administrator). Membership of a shop is not enough.
export const canCreateShops: TController = async ( req, res, next ) => {
    const user = req.user as IUserDocument

    if (user.role === "shopMg" || isAdmin(user)) {
        next()
    } else {
        next(createError(403, "Shop Manager Only!!"))
    }
}

// -------------------------------------------------------------------------

// After JWTAuthMiddleware: the user is a member of the shop in :shopId, or an
// administrator (404 if there's no such shop). Sets req.shopRole to how they
// got through (the staff routes read it), and fills an older shop's membership
// on the way (model.ts).
export const isShopManager: TController = async ( req, res, next ) => {
    try {
        const role = await shopRoleOf(req)
        if (role === undefined) return next(createError(404, `Shop Not Found!`))
        if (!role) return next(createError(403, `Shop Manager Only!`))
        req.shopRole = role
        next()
    } catch (error) {
        next(error)
    }
}

// After JWTAuthMiddleware: the user owns the shop in :shopId, or is an
// administrator. A member who isn't the owner is refused, as is everyone else.
export const isShopOwner: TController = async ( req, res, next ) => {
    try {
        const role = await shopRoleOf(req)
        if (role === undefined) return next(createError(404, `Shop Not Found!`))
        if (role !== "owner" && role !== "admin") return next(createError(403, `Only the owner can do this`))
        req.shopRole = role
        next()
    } catch (error) {
        next(error)
    }
}

// The caller's standing on the shop in :shopId: "admin", their member role,
// null for a stranger, undefined for no such shop. Reads the membership, which
// fills an older shop's owner and members first (an administrator's visit
// fills it too), so the role it reads is always there.
const shopRoleOf = async (req: Request) => {
    const user = req.user as IUserDocument
    const shop = await membershipOf(req.params.shopId as string)
    if (!shop) return undefined
    if (isAdmin(user)) return "admin" as const
    return shop.members.find((m) => m.userId.equals(String(user._id)))?.role ?? null
}

// -------------------------------------------------------------------------