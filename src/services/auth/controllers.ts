import { TController } from "src/typings/controllers"
import UserModel from "../users/model"
import { getTokens, refreshTokens } from "./tools"
import createError from "http-errors"
import { IGoogleUser } from "src/typings/users"

// -------------------------------------------------------------------------

export const registerUser: TController = async (req, res, next) => {
    const newUser = { ...req.body }

    try {
        newUser.avatar = `https://ui-avatars.com/api/?name=${req.body.name}+${req.body.surname}`
        const user = await new UserModel(newUser).save()
        const { accessToken, refreshToken } = await getTokens(user)

        res.cookie("accessToken", accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production" ? true : false,
            // sameSite: "none",
        })
        res.cookie("refreshToken", refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production" ? true : false,
            // sameSite: "none",
        })
        res.status(204).send(user)
    } catch (error) {
        next(createError(400, error as Error))
    }
}

// -------------------------------------------------------------------------

export const loginUser: TController = async ( req, res, next ) => {
    const { email, password } = req.body

    try {
        const user = await UserModel.checkCredentials(email, password)
        if (!user) return next(createError(401, "Invalid credentials"))

        const { accessToken, refreshToken } = await getTokens(user)

        res.cookie("accessToken", accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production" ? true : false,
            // sameSite: "none",
        })
        res.cookie("refreshToken", refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production" ? true : false,
            // sameSite: "none",
        })
        res.status(204).send()
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
        if(!tokens) return next(createError(401, "Invalid token"))

        res.cookie("accessToken", tokens.accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production" ? true : false,
            // sameSite: "none",
        })
        res.cookie("refreshToken", refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production" ? true : false,
            // sameSite: "none",
        })
        res.status(204).send()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const googleRedirect: TController =  async (req, res, next) => {
    try {
        const user = req.user as IGoogleUser
        const { accessToken, refreshToken } = user.tokens

        res.cookie("accessToken", accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production" ? true : false,
            // sameSite: "none",
        })
        res.cookie("refreshToken", refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production" ? true : false,
            // sameSite: "none",
        })

        res.redirect(`${process.env.FRONTEND_DEV_URL}`)
    } catch (error) {
        console.log(error)
        next(createError(500, error as Error))
    }
}

// -------------------------------------------------------------------------

export const logoutUser: TController = async (req, res, next) => {
    try {
        res.clearCookie("accessToken")
        res.clearCookie("refreshToken")
        res.status(204).send()
    } catch (error) {
        console.log(error)
        next(error)
    }
}

// -------------------------------------------------------------------------