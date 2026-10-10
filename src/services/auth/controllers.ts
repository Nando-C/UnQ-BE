import { TController } from "src/typings/controllers"
import UserModel from "../users/model"
import { clearAuthCookies, getTokens, refreshTokens, setAuthCookies } from "./tools"
import createError from "http-errors"
import { IGoogleUser, IUserDocument } from "src/typings/users"
import env from "../../settings/env"
import { isDuplicateKey } from "../../lib/mongo"
import { TOO_MANY_WRONG_PASSWORDS } from "../../lib/passwordLimit"

export const registerUser: TController = async (req, res, next) => {
    const { name, surname, email, password } = req.body
    const newUser = { name, surname, email, password } as Record<string, unknown>

    try {
        newUser.avatar = `https://ui-avatars.com/api/?name=${req.body.name}+${req.body.surname}`
        const user = await new UserModel(newUser).save()
        setAuthCookies(res, await getTokens(user))
        res.status(201).send(user)
    } catch (error) {
        if (isDuplicateKey(error)) {
            return next(createError(409, "Email already registered"))
        }
        next(createError(400, (error as Error).message))
    }
}

// -------------------------------------------------------------------------

export const loginUser: TController = async ( req, res, next ) => {
    const { email, password } = req.body

    try {
        const user = await UserModel.checkCredentials(email, password)
        if (user === "locked") return next(createError(429, TOO_MANY_WRONG_PASSWORDS))
        if (!user) return next(createError(401, "Invalid credentials"))

        setAuthCookies(res, await getTokens(user))
        res.send(user)
    } catch (error) {
        next(createError(500, error as Error))
    }
} 

// -------------------------------------------------------------------------

export const tokenRefresh: TController = async (req, res, next) => {
    const { refreshToken } = req.cookies
    if (!refreshToken) return next(createError(400, "Refresh token MUST be provided!"))

    try {
        const tokens = await refreshTokens(refreshToken)
        if (!tokens) {
            // The session is over: the cookies go, so the diner's next request
            // is a guest's instead of another 401 (see optionalJWT).
            clearAuthCookies(res)
            return next(createError(401, "Invalid token"))
        }
        // Another tab refreshed moments ago; clearing here would wipe the new
        // cookies it just got. Said so, so this tab can resend its request
        // with them (UnQ-FE's interceptor does).
        if (tokens === "superseded") return next(createError(401, "Invalid token", { reason: "superseded" }))

        setAuthCookies(res, tokens)
        res.status(200).send()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const googleRedirect: TController =  async (req, res, next) => {
    try {
        const user = req.user as IGoogleUser
        setAuthCookies(res, user.tokens)

        res.redirect(env.FRONTEND_ORIGIN)
    } catch (error) {
        console.log(error)
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const logoutUser: TController = async (req, res, next) => {
    try {
        const user = req.user as IUserDocument
        await user.updateOne({ refreshToken: "" })
        
        clearAuthCookies(res)
        res.status(204).send()
    } catch (error) {
        console.log(error)
        next(error)
    }
}

// -------------------------------------------------------------------------