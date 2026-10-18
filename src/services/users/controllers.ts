import { TController } from "../../typings/controllers"
import { IUserDocument } from "src/typings/users"
import createError from "http-errors"
import * as bcrypt from "bcrypt"
import { destroyReplacedImage, discardUpload } from "../../settings/cloudinary"
import { clearAuthCookies, deviceOf, getTokens, setAuthCookies } from "../auth/tools"
import ShopModel, { ownedBy } from "../shops/model"
import UserModel, { isAdmin } from "./model"
import { isDuplicateKey } from "../../lib/mongo"
import { ListUsersQuery } from "./schemas"
import { Types } from "mongoose"
import { Request } from "express"
import mongoose from "mongoose"
import { escapeRegExp } from "../../lib/regexp"
import { limitedPasswordCheck, TOO_MANY_WRONG_PASSWORDS } from "../../lib/passwordLimit"

// -------------------------------------------------------------------------

export const getMe: TController = async ( req, res) => {
    res.json(req.user)
}

// -------------------------------------------------------------------------

// Why the account's current password doesn't allow `what`, or null when it
// does (or the account has none). 403, not 401, for a wrong one: a 401 would
// send the FE to refresh the session. Wrong ones count towards the account's
// limit, as at sign-in (see lib/passwordLimit.ts).
const currentPasswordRefusal = async (me: IUserDocument, currentPassword: unknown, what: string) => {
    if (!me.password) return null
    if (typeof currentPassword !== "string" || !currentPassword) {
        return createError(400, `Enter your current password to ${what}`)
    }
    const hash = me.password
    const right = await limitedPasswordCheck(String(me._id), () => bcrypt.compare(currentPassword, hash))
    if (right === "locked") return createError(429, TOO_MANY_WRONG_PASSWORDS)
    if (!right) return createError(403, "Your current password is incorrect")
    return null
}

// Changing the email or password of an account that has a password needs the
// current one (`currentPassword`): a stolen access token alone can't take the
// account over. A Google-only account can't get a password at all: there's
// nothing to confirm it with, so a stolen token could set one and keep the
// account for good. A new password ends the account's other sessions: a new
// session for this device, and every other device's goes.
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
            setAuthCookies(res, await getTokens(me, deviceOf(req), { only: true }))
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
        // An administrator's account is another administrator's to delete, so
        // the last one can't take the role away by leaving.
        if (isAdmin(me)) return next(createError(409, "An administrator's account is deleted by another administrator"))
        // An owner's shops would be left with no one to delete them or settle
        // their payments: they're handed over or deleted first.
        if (await ShopModel.exists(ownedBy(me._id))) return next(createError(409, "Delete your shops first"))
        await removeAccount(me)
        // The session ends with the account.
        clearAuthCookies(res)
        res.status(204).send()
    } catch {
        next(createError(500, "An Error ocurred while deleting the user"))
    }
}

// -------------------------------------------------------------------------
// -------------------------------------------------------------------------
// An administrator's account routes (isAdministrator).

// Deletes an account: the shops it works at lose it (both membership lists, in
// one update each), and its sessions go with the document. The caller has
// checked it owns no shop.
const removeAccount = async (user: IUserDocument) => {
    await ShopModel.updateMany({ shopMg: user._id }, { $pull: { shopMg: user._id, members: { userId: user._id } } })
    await user.deleteOne()
}


// A page of accounts, newest first, each with the shops it is a member of and
// its role on each. `q` matches the name, surname or email, case aside.
export const listUsers: TController = async ( req, res, next ) => {
    try {
        const { q, role, page, limit } = res.locals.query as ListUsersQuery
        const text = q ? new RegExp(escapeRegExp(q), "i") : undefined
        const filter = {
            ...(role && { role }),
            ...(text && { $or: [{ name: text }, { surname: text }, { email: text }] }),
        }
        const [users, total] = await Promise.all([
            UserModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
            UserModel.countDocuments(filter),
        ])
        const ids = users.map((u) => u._id)
        const shops = await ShopModel.find({ shopMg: { $in: ids } }).select("name members shopMg ownerId").lean()
        // A shop from before membership that no member has opened yet has no
        // members: its roles read as membershipOf will fill them.
        const roleOn = (shop: (typeof shops)[number], userId: string) =>
            shop.ownerId
                ? shop.members.find((m) => m.userId.equals(userId))?.role
                : shop.shopMg.some((id) => id.equals(userId)) ? (shop.shopMg[0].equals(userId) ? "owner" : "manager") : undefined
        res.send({
            users: users.map((user) => ({
                ...user.toJSON(),
                shops: shops.flatMap((shop) => {
                    const role = roleOn(shop, String(user._id))
                    return role ? [{ _id: shop._id, name: shop.name, role }] : []
                }),
            })),
            total,
            page,
            limit,
        })
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// An account made by an administrator, with any role; the person is told the
// password and changes it on their account page.
export const createUser: TController = async ( req, res, next ) => {
    const admin = req.user as IUserDocument
    try {
        const { name, surname, email, password, role } = req.body
        const user = await new UserModel({
            name, surname, email, password, role,
            avatar: `https://ui-avatars.com/api/?name=${name}+${surname}`,
            createdBy: admin._id,
        }).save()
        res.status(201).send(user)
    } catch (error) {
        if (isDuplicateKey(error)) return next(createError(409, "Email already registered"))
        next(createError(500, error as Error))
    }
}

// The account the administrator's route is about, or a 404.
const accountIn = async (req: Request) => {
    const id = req.params.userId as string
    return mongoose.isValidObjectId(id) ? UserModel.findById(id) : null
}

// An account's role. Not the caller's own, so an administrator can't demote
// themselves and the last one stays (another administrator would have to exist
// to demote them; two acting on each other in the same instant is the accepted
// residual), and not `admin` for an account on a shop (an administrator is
// never a member).
export const setRole: TController = async ( req, res, next ) => {
    const admin = req.user as IUserDocument
    try {
        const user = await accountIn(req)
        if (!user) return next(createError(404, "User not found"))
        if (user._id.equals(String(admin._id))) return next(createError(400, "You can't change your own role"))
        const { role } = req.body as { role: string }
        if (role === "admin" && (await ShopModel.exists({ shopMg: user._id }))) {
            return next(createError(409, "Hand over or leave their shops first"))
        }
        user.role = role
        await user.save()
        res.send(user)
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// Deletes any account but the caller's own (so the last administrator stays, as
// above) or one that owns a shop (handed over or deleted first).
export const deleteUser: TController = async ( req, res, next ) => {
    const admin = req.user as IUserDocument
    try {
        const user = await accountIn(req)
        if (!user) return next(createError(404, "User not found"))
        if (user._id.equals(String(admin._id))) return next(createError(400, "Another administrator deletes your account"))
        if (await ShopModel.exists(ownedBy(user._id as Types.ObjectId))) return next(createError(409, "Transfer or delete their shops first"))
        await removeAccount(user)
        res.status(204).send()
    } catch (error) {
        next(createError(500, error as Error))
    }
}
