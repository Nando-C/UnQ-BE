import { randomUUID } from "crypto"
import { Request, Response } from "express"
import jwt from "jsonwebtoken"
import mongoose from "mongoose"
import { IJWTPayload } from "src/typings/jwt"
import { ISession, IUserDocument } from "src/typings/users"
import UserModel from "../users/model"
import env from "../../settings/env"

// -------------------------------------------------------------------------

const ACCESS_TOKEN_TTL = "15m"
const REFRESH_TOKEN_TTL = "4w"
// The same four weeks, for telling a session whose token has run out.
const REFRESH_TOKEN_TTL_MS = 4 * 7 * 24 * 60 * 60 * 1000

// How many devices an account can be signed in on at once; beyond it, the
// oldest sign-in goes.
export const MAX_SESSIONS = 10

const generateJWT = (payload: IJWTPayload) =>
    new Promise((resolve, reject)=>
        jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL}, (err, token) => {
            if (err) reject(err)
            resolve(token)
        })
    )

// A refresh token's id (`jti`) is what the session stores and what rotation
// matches, never the token itself: two issued within the same second would
// otherwise be identical, and a copy of the database could sign in.
const generateRefreshJWT = (payload: IJWTPayload, jti: string) =>
    new Promise((resolve, reject)=>
        jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_TTL, jwtid: jti }, (err, token) => {
            if (err) reject(err)
            resolve(token)
        })
    )

// -------------------------------------------------------------------------

// A new access + refresh token pair for one session, not yet stored. Both
// carry the session's id, so a request knows which device it comes from.
const signTokens = async (user: IUserDocument, sid: string, jti: string) => {
    const payload: IJWTPayload = { _id: user._id, sid }
    const accessToken = (await generateJWT(payload)) as string
    const refreshToken = (await generateRefreshJWT(payload, jti)) as string
    return { accessToken, refreshToken }
}

// What a session remembers about the device, from its request.
export type Device = { userAgent?: string }
export const deviceOf = (req: Request): Device => {
    const userAgent = req.headers["user-agent"]
    return userAgent ? { userAgent: userAgent.slice(0, 200) } : {}
}

// Whether a session's refresh token can still be used (one not rotated for
// four weeks has expired; the session is kept until the next sign-in sweeps it).
export const alive = (session: ISession) => Date.now() - session.lastUsedAt.getTime() < REFRESH_TOKEN_TTL_MS

// Signs a device in: a new session on the account, with its own refresh
// token, beside the ones other devices hold. `only` ends every other session
// first (a password change). Sessions whose token has expired are dropped on
// the way, and beyond MAX_SESSIONS the oldest sign-in is. Each step is one
// atomic update, so two sign-ins at once on one account both land.
export const getTokens = async (user: IUserDocument, device: Device, { only = false } = {}) => {
    const sid = new mongoose.Types.ObjectId()
    const jti = randomUUID()
    const now = new Date()
    const session = { _id: sid, jti, createdAt: now, lastUsedAt: now, ...device }

    if (only) {
        await UserModel.updateOne({ _id: user._id }, { $set: { sessions: [session] } })
    } else {
        await UserModel.updateOne({ _id: user._id }, { $pull: { sessions: { lastUsedAt: { $lt: new Date(Date.now() - REFRESH_TOKEN_TTL_MS) } } } })
        await UserModel.updateOne({ _id: user._id }, { $push: { sessions: { $each: [session], $slice: -MAX_SESSIONS } } })
    }

    return signTokens(user, String(sid), jti)
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

// How recently the session's token must have been rotated for the one it
// replaced to count as another tab's race (see refreshTokens).
const RACE_WINDOW_SECONDS = 60

// New tokens for a valid refresh token. Otherwise null when the session is
// over: the token is expired, malformed or signed with another key, its user is
// gone, or its session is (a logout, a revocation, a password change, an
// account signed in on too many devices), or it was replaced a while ago. Or
// "superseded" when it was replaced moments ago: another tab in the same
// browser just refreshed, and the cookies it got are still good. The route
// answers both with a 401 — not a server fault — and only null clears the
// cookies. Database errors still throw (a 500).
export const refreshTokens = async ( currentRefreshToken: string) => {
    let decoded: jwt.JwtPayload
    try {
        decoded = (await verifyRefreshJWT(currentRefreshToken)) as jwt.JwtPayload
    } catch {
        return null
    }

    const user = await UserModel.findById(decoded._id)
    if (!user || !decoded.jti) return null

    const session = user.sessions.find((s) => s.jti === decoded.jti)
    if (session) {
        // Stored only if the token is still the session's current one, in one
        // step: of two refreshes racing with it (two tabs), one gets the new
        // pair and the other is told it was superseded, so the browser can't be
        // left holding a pair the database no longer has.
        const jti = randomUUID()
        const tokens = await signTokens(user, String(session._id), jti)
        const now = new Date()
        const swapped = await UserModel.updateOne(
            { _id: user._id, "sessions.jti": decoded.jti },
            { $set: { "sessions.$.jti": jti, "sessions.$.previousJti": decoded.jti, "sessions.$.rotatedAt": now, "sessions.$.lastUsedAt": now } }
        )
        return swapped.modifiedCount === 1 ? tokens : ("superseded" as const)
    }
    const replaced = user.sessions.find((s) => s.previousJti === decoded.jti)
    const justRotated = !!replaced?.rotatedAt && Date.now() - replaced.rotatedAt.getTime() < RACE_WINDOW_SECONDS * 1000
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
