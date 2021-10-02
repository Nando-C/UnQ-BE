import mongoose, { Document, Model } from "mongoose"

export interface IUser {
    name: string
    surname: string
    email: string
    password?: string
    avatar?: string
    role: string
    refreshToken?: string
    googleId?: string
}

export interface IUserDocument extends Document, IUser {}

export interface IUserModel extends Model<IUserDocument> {
    checkCredentials (email: string, password: string): Promise<IUserDocument | null>
}

export interface IGoogleUser extends IUserDocument {
    tokens: {
        accessToken: string
        refreshToken: string
    }
}