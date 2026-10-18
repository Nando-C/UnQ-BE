import { Document, Model, Types } from "mongoose"

// One signed-in device (see auth/tools.ts).
export interface ISession {
    _id: Types.ObjectId
    // The id (`jti`) of the refresh token this device holds now...
    jti: string
    // ...and of the one it held before the last rotation, with when: a tab
    // that lost a refresh race is told so for a minute afterwards.
    previousJti?: string
    rotatedAt?: Date
    createdAt: Date
    lastUsedAt: Date
    userAgent?: string
}

export interface IUser {
    name: string
    surname?: string
    email: string
    password?: string
    avatar?: string
    // "customer" | "shopMg" | "admin" (users/model.ts).
    role: string
    sessions: ISession[]
    googleId?: string
}

export interface IUserDocument extends Document, IUser {}

export interface IUserModel extends Model<IUserDocument> {
    checkCredentials (email: string, password: string): Promise<IUserDocument | null | "locked">
}

export interface IGoogleUser extends IUserDocument {
    tokens: {
        accessToken: string
        refreshToken: string
    }
}
