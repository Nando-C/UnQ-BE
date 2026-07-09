import jwt from "jsonwebtoken"
import { IJWTPayload } from "src/typings/jwt"
import { IUserDocument } from "src/typings/users"
import UserModel from "../users/model"

// -------------------------------------------------------------------------

const ACCESS_TOKEN_TTL = "15m"
const REFRESH_TOKEN_TTL = "4w"

const generateJWT = (payload: IJWTPayload) =>
    new Promise((resolve, reject)=>
        jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: ACCESS_TOKEN_TTL}, (err, token) => {
            if (err) reject(err)
            resolve(token)
        })
    )

const generateRefreshJWT = (payload: IJWTPayload) =>
    new Promise((resolve, reject)=>
        jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, { expiresIn: REFRESH_TOKEN_TTL}, (err, token) => {
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
        jwt.verify(token, process.env.JWT_SECRET!, (err, decodedToken) => {
            if (err) reject(err)
            resolve(decodedToken)
        })
    )

// -------------------------------------------------------------------------

export const verifyRefreshJWT = (token: string) => 
    new Promise((resolve, reject) => 
        jwt.verify(token, process.env.JWT_REFRESH_SECRET!, (err, decodedToken) => {
            if (err) reject (err)
            resolve(decodedToken)
        })
    )

// -------------------------------------------------------------------------

export const refreshTokens = async ( currentRefreshToken: string) => {
    try {
        const decoded = (await verifyRefreshJWT(currentRefreshToken)) as jwt.JwtPayload
        const user = await UserModel.findById(decoded._id)

        if (!user) return null

        if (currentRefreshToken === user.refreshToken) {
            const { accessToken, refreshToken } = await getTokens(user)
            return { accessToken, refreshToken }
        } else return null
    } catch {
        throw new Error("Token not valid!")
    }
}

// -------------------------------------------------------------------------