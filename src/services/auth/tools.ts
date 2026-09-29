import { randomUUID } from "crypto"
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

// New tokens for a valid refresh token. Otherwise null when the session is
// over (the token is expired, malformed or signed with another key, or its user
// is gone), or "superseded" when it was already rotated: another tab may have
// just refreshed, and its new cookies are still good. The route answers both
// with a 401 — not a server fault. Database errors still throw (a 500).
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
    } else return "superseded" as const
}

// -------------------------------------------------------------------------