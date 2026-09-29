import { TController } from "../../typings/controllers"
import { IUserDocument } from "src/typings/users"
import createError from "http-errors"
import * as bcrypt from "bcrypt"
import { destroyReplacedImage, discardUpload } from "../../settings/cloudinary"
import { getTokens } from "../auth/tools"

// -------------------------------------------------------------------------

export const getMe: TController = async ( req, res) => {
    res.json(req.user)
}

// -------------------------------------------------------------------------

// Changing the email or password of an account that has a password needs the
// current one (`currentPassword`): a stolen access token alone can't take the
// account over. A new password ends the account's other sessions: new tokens
// for this one, and the stored refresh token everyone else holds is replaced.
export const editMe: TController = async ( req, res, next) => {
    const me = req.user as IUserDocument
    try {
        const { name, surname, email, password, currentPassword } = req.body
        const emailChanges = email !== undefined && email.trim().toLowerCase() !== me.email
        if ((emailChanges || password !== undefined) && me.password) {
            if (!currentPassword) return next(createError(400, "Enter your current password to change your email or password"))
            if (!(await bcrypt.compare(currentPassword, me.password))) {
                // 403, not 401: a 401 would send the FE to refresh the session.
                return next(createError(403, "Your current password is incorrect"))
            }
        }
        if (name !== undefined) me.name = name
        if (surname !== undefined) me.surname = surname
        if (emailChanges) me.email = email
        if (password !== undefined) me.password = password

        await me.save()
        if (password !== undefined) {
            const { accessToken, refreshToken } = await getTokens(me)
            res.cookie("accessToken", accessToken, { httpOnly: true, secure: true, sameSite: "none" })
            res.cookie("refreshToken", refreshToken, { httpOnly: true, secure: true, sameSite: "none" })
        }
        res.send(me)
    } catch (error) {
        const mongoError = error as { code?: number; cause?: { code?: number } }
        if (mongoError.code === 11000 || mongoError.cause?.code === 11000) {
            return next(createError(409, "Email already registered"))
        }
        next(createError(500, "An Error ocurred while updating the user"))
    }
}

// -------------------------------------------------------------------------

export const editMyAvatar: TController = async ( req, res, next) => {
    const me = req.user as IUserDocument
    try {
        const previous = me.avatar
        me.avatar = req.file?.path
        await me.save()
        destroyReplacedImage(previous)
        res.send(me)
    } catch {
        discardUpload(req)
        next(createError(500, "An Error ocurred while updating the user's avatar"))
    }
}

// -------------------------------------------------------------------------

export const deleteMe: TController = async ( req, res, next ) => {
    const me = req.user as IUserDocument
    try {
        await me.deleteOne()
        res.status(204).send()
    } catch {
        next(createError(500, "An Error ocurred while deleting the user"))
    }
}

// -------------------------------------------------------------------------