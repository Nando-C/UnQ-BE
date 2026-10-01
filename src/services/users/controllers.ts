import { TController } from "../../typings/controllers"
import { IUserDocument } from "src/typings/users"
import createError from "http-errors"
import * as bcrypt from "bcrypt"
import { destroyReplacedImage, discardUpload } from "../../settings/cloudinary"
import { clearAuthCookies, getTokens, setAuthCookies } from "../auth/tools"
import ShopModel from "../shops/model"
import { isDuplicateKey } from "../../lib/mongo"

// -------------------------------------------------------------------------

export const getMe: TController = async ( req, res) => {
    res.json(req.user)
}

// -------------------------------------------------------------------------

// Why the account's current password doesn't allow `what`, or null when it
// does (or the account has none). 403, not 401, for a wrong one: a 401 would
// send the FE to refresh the session.
const currentPasswordRefusal = async (me: IUserDocument, currentPassword: unknown, what: string) => {
    if (!me.password) return null
    if (typeof currentPassword !== "string" || !currentPassword) {
        return createError(400, `Enter your current password to ${what}`)
    }
    if (!(await bcrypt.compare(currentPassword, me.password))) return createError(403, "Your current password is incorrect")
    return null
}

// Changing the email or password of an account that has a password needs the
// current one (`currentPassword`): a stolen access token alone can't take the
// account over. A Google-only account can't get a password at all: there's
// nothing to confirm it with, so a stolen token could set one and keep the
// account for good. A new password ends the account's other sessions: new
// tokens for this one, and the stored refresh token everyone else holds is
// replaced.
export const editMe: TController = async ( req, res, next) => {
    const me = req.user as IUserDocument
    try {
        const { name, surname, email, password, currentPassword } = req.body
        if (password !== undefined && !me.password) {
            return next(createError(403, "This account signs in with Google, so it can't have a password"))
        }
        const emailChanges = email !== undefined && email.trim().toLowerCase() !== me.email
        if (emailChanges || password !== undefined) {
            const refusal = await currentPasswordRefusal(me, currentPassword, "change your email or password")
            if (refusal) return next(refusal)
        }
        if (name !== undefined) me.name = name
        if (surname !== undefined) me.surname = surname
        if (emailChanges) me.email = email
        if (password !== undefined) me.password = password

        await me.save()
        if (password !== undefined) {
            setAuthCookies(res, await getTokens(me))
        }
        res.send(me)
    } catch (error) {
        if (isDuplicateKey(error)) {
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

// Deleting an account that has a password needs it (`currentPassword`), as
// changing its email does: a stolen access token alone can't delete it.
export const deleteMe: TController = async ( req, res, next ) => {
    const me = req.user as IUserDocument
    try {
        const refusal = await currentPasswordRefusal(me, req.body?.currentPassword, "delete your account")
        if (refusal) return next(refusal)
        // A manager's shops would be left with no one to run them (or settle
        // their payments): they're deleted first.
        if (await ShopModel.exists({ shopMg: me._id })) return next(createError(409, "Delete your shops first"))
        await me.deleteOne()
        // The session ends with the account.
        clearAuthCookies(res)
        res.status(204).send()
    } catch {
        next(createError(500, "An Error ocurred while deleting the user"))
    }
}

// -------------------------------------------------------------------------