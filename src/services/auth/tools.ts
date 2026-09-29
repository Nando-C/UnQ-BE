import { randomUUID } from "crypto"
import { Response } from "express"
import jwt from "jsonwebtoken"
import { IJWTPayload } from "src/typings/jwt"
import { IUserDocument } from "src/typings/users"
import UserModel from "../users/model"
import env from "../../settings/env"

// -------------------------------------------------------------------------

const ACCESS_TOKEN_TTL = "15m"
const REFRESH_TOKEN_TTL = "4w"

const generateJWT = (payload: IJWTPayload) =>
    new Promise((resolve, reject)=>
        jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL}, (err, token) => {
            if (err) reject(err)
            resolve(token)
        })
    )

// Each refresh token gets its own id: two issued within the same second would
// otherwise be identical, and rotation couldn't tell the old one from the new.
const generateRefreshJWT = (payload: IJWTPayload) =>
    new Promise((resolve, reject)=>
        jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_TTL, jwtid: randomUUID() }, (err, token) => {
            if (err) reject(err)
            resolve(token)
        })
    )

// -------------------------------------------------------------------------
    
// A new access + refresh token pair. The refresh token is stored on the user,
// so it replaces the one any other session holds (see refreshTokens).
export const getTokens = async (user: IUserDocument) => {
    const accessToken = (await generateJWT({ _id: user._id })) as string
    const refreshToken = (await generateRefreshJWT({ _id: user._id })) as string

    user.refreshToken = refreshToken

    await user.save()

    return { accessToken, refreshToken}
}

// -------------------------------------------------------------------------

export const verifyJWT = (token: string) => 
    new Promise((resolve, reject) => 
        jwt.verify(token, env.JWT_SECRET, (err, decodedToken) => {
            if (err) reject(err)
            resolve(decodedToken)
        })
    )

// -------------------------------------------------------------------------

export const verifyRefreshJWT = (token: string) => 
    new Promise((resolve, reject) => 
        jwt.verify(token, env.JWT_REFRESH_SECRET, (err, decodedToken) => {
            if (err) reject (err)
            resolve(decodedToken)
        })
    )

// -------------------------------------------------------------------------

// How recently the user's token must have been rotated for an older one to
// count as another tab's race (see refreshTokens).
const RACE_WINDOW_SECONDS = 60

// New tokens for a valid refresh token. Otherwise null when the session is
// over: the token is expired, malformed or signed with another key, its user is
// gone, or it was replaced a while ago (a sign-in on another device, a
// logout, a password change). Or "superseded" when it was replaced moments ago:
// another tab in the same browser just refreshed, and the cookies it got are
// still good. The route answers both with a 401 — not a server fault — and
// only null clears the cookies. Database errors still throw (a 500).
export const refreshTokens = async ( currentRefreshToken: string) => {
    let decoded: jwt.JwtPayload
    try {
        decoded = (await verifyRefreshJWT(currentRefreshToken)) as jwt.JwtPayload
    } catch {
        return null
    }

    const user = await UserModel.findById(decoded._id)
    if (!user) return null

    if (currentRefreshToken === user.refreshToken) {
        const { accessToken, refreshToken } = await getTokens(user)
        return { accessToken, refreshToken }
    }
    const current = jwt.decode(user.refreshToken ?? "") as jwt.JwtPayload | null
    const justRotated = !!current?.iat && Date.now() / 1000 - current.iat < RACE_WINDOW_SECONDS
    return justRotated ? ("superseded" as const) : null
}

// -------------------------------------------------------------------------

// The auth cookies' options. Clearing a cookie needs the options it was set
// with: a cross-site response can only touch a SameSite=None; Secure cookie
// with those attributes, so both go through these.
const AUTH_COOKIE = { httpOnly: true, secure: true, sameSite: "none" } as const

export const setAuthCookies = (res: Response, tokens: { accessToken: string; refreshToken: string }) => {
    res.cookie("accessToken", tokens.accessToken, AUTH_COOKIE)
    res.cookie("refreshToken", tokens.refreshToken, AUTH_COOKIE)
}

export const clearAuthCookies = (res: Response) => {
    res.clearCookie("accessToken", AUTH_COOKIE)
    res.clearCookie("refreshToken", AUTH_COOKIE)
}
