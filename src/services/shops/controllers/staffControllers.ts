import { TController } from "../../../typings/controllers"
import { IUserDocument } from "src/typings/users"
import { MemberRole } from "src/typings/shop"
import createError from "http-errors"
import mongoose, { Types } from "mongoose"
import ShopModel, { membershipOf } from "../model"
import UserModel, { isAdmin } from "../../users/model"
import { isDuplicateKey } from "../../../lib/mongo"

// A shop's staff: who is on it, adding someone (creating their account when
// there is none), removing someone, handing the shop over. Who may do which is
// in docs/auth.md#roles-and-ownership; the guard has set req.shopRole.

// A write that found the staff changed since the caller read them (a hand-over,
// a removal, a deletion in the same instant): the caller re-reads and retries.
const STAFF_CHANGED = "The shop's staff changed, please retry"

// The members joined to their accounts, the owner first.
const staffOf = async (shopId: string) => {
    const shop = await ShopModel.findById(shopId).select("members")
        .populate<{ members: { userId: { _id: Types.ObjectId; name: string; surname?: string; email: string; avatar?: string } | null; role: MemberRole; since: Date; addedBy?: Types.ObjectId }[] }>({ path: "members.userId", select: "name surname email avatar" })
    if (!shop) return null
    const rows = shop.members.map((m) => ({
        userId: m.userId?._id ?? null,
        name: m.userId?.name ?? null,
        surname: m.userId?.surname,
        email: m.userId?.email ?? null,
        avatar: m.userId?.avatar,
        role: m.role,
        since: m.since,
        addedBy: m.addedBy,
    }))
    return rows.sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner"))
}

export const listStaff: TController = async ( req, res, next ) => {
    try {
        const members = await staffOf(req.params.shopId)
        if (!members) return next(createError(404, "Shop Not Found!"))
        res.send({ members })
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// Whether a caller with `callerRole` may add or remove a member with `role`:
// the owner (or an administrator) anyone but the owner; a manager only the
// roles below manager (none yet).
const mayHandle = (callerRole: string | undefined, role: MemberRole) =>
    role !== "owner" && (callerRole === "owner" || callerRole === "admin" || (callerRole === "manager" && role !== "manager"))

// Adds a person to the shop by their email: the account with that address, or
// a new one (name, surname and a first password, which the caller tells them;
// account role customer whatever membership role they get). One update puts
// them in both membership lists, conditioned on their absence, so two adds of
// one person land once. 201 when the account was created, 200 when it existed.
export const addStaff: TController = async ( req, res, next ) => {
    const caller = req.user as IUserDocument
    try {
        const { email, role, name, surname, password } = req.body as { email: string; role: MemberRole; name?: string; surname?: string; password?: string }
        if (!mayHandle(req.shopRole, role)) return next(createError(403, "Only the owner adds managers"))
        if (email === caller.email) return next(createError(400, "That is your own address"))

        let user = await UserModel.findOne({ email })
        let created = false
        if (!user) {
            const missing = [["name", name], ["surname", surname], ["password", password]].filter(([, v]) => !v).map(([path]) => ({ path, message: "Required for a new account" }))
            if (missing.length) return next(createError(400, "Validation failed", { details: missing }))
            try {
                user = await new UserModel({ name, surname, email, password, avatar: `https://ui-avatars.com/api/?name=${name}+${surname}`, createdBy: caller._id }).save()
                created = true
            } catch (error) {
                // Registered in the same instant: theirs, attached below.
                if (!isDuplicateKey(error)) throw error
                user = await UserModel.findOne({ email })
                if (!user) return next(createError(409, STAFF_CHANGED))
            }
        }
        if (isAdmin(user)) return next(createError(409, "An administrator can't be a member of a shop"))

        const added = await ShopModel.updateOne(
            { _id: req.params.shopId, ownerId: { $exists: true }, "members.userId": { $ne: user._id } },
            { $push: { shopMg: user._id, members: { userId: user._id, role, since: new Date(), addedBy: caller._id } } },
        )
        if (added.matchedCount === 0) {
            // Already there, or the shop went (or has nobody on it: membershipOf
            // can't fill a shop with an empty shopMg, so it has no owner).
            const shop = await membershipOf(req.params.shopId)
            if (!shop) return next(createError(404, "Shop Not Found!"))
            return next(createError(409, shop.members.some((m) => m.userId.equals(user!._id)) ? "Already a member" : STAFF_CHANGED))
        }

        const members = (await staffOf(req.params.shopId))!
        res.status(created ? 201 : 200).send({ member: members.find((m) => m.userId?.equals(user!._id)), created })
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// Removes a member: the owner (or an administrator) anyone but the owner, a
// manager only the roles below manager, anyone themselves. The owner is never
// removed: the shop is handed over first. The account stays.
export const removeStaff: TController = async ( req, res, next ) => {
    const caller = req.user as IUserDocument
    try {
        const { shopId, userId } = req.params
        const shop = await membershipOf(shopId)
        if (!shop) return next(createError(404, "Shop Not Found!"))
        const member = mongoose.isValidObjectId(userId) ? shop.members.find((m) => m.userId.equals(userId)) : undefined
        if (!member) return next(createError(404, "Not a member of this shop"))
        if (member.role === "owner") return next(createError(403, "The owner can't be removed"))
        const themselves = member.userId.equals(String(caller._id))
        if (!themselves && !mayHandle(req.shopRole, member.role)) return next(createError(403, "Only the owner removes a manager"))

        // Matched on the member still not being the owner: a hand-over landing
        // in the same instant would otherwise leave the shop with no owner on it.
        const removed = await ShopModel.updateOne(
            { _id: shopId, members: { $elemMatch: { userId: member.userId, role: { $ne: "owner" } } } },
            { $pull: { shopMg: member.userId, members: { userId: member.userId } } },
        )
        if (removed.matchedCount === 0) return next(createError(409, STAFF_CHANGED))
        res.status(204).send()
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// The shop's owner (or an administrator) makes another member the owner; the
// previous owner becomes a manager. One update, matched on the current owner,
// so two hand-overs at once land once.
export const handOver: TController = async ( req, res, next ) => {
    try {
        const { shopId } = req.params
        const { userId } = req.body as { userId: string }
        const shop = await membershipOf(shopId)
        if (!shop) return next(createError(404, "Shop Not Found!"))
        const member = shop.members.find((m) => m.userId.equals(userId))
        if (!member) return next(createError(404, "Not a member of this shop"))
        if (member.role === "owner") return next(createError(409, "Already the owner"))

        const previous = shop.ownerId!
        const handed = await ShopModel.updateOne(
            { _id: shopId, ownerId: previous, "members.userId": member.userId },
            { $set: { ownerId: member.userId, "members.$[next].role": "owner", "members.$[prev].role": "manager" } },
            { arrayFilters: [{ "next.userId": member.userId }, { "prev.userId": previous }] },
        )
        if (handed.matchedCount === 0) return next(createError(409, STAFF_CHANGED))
        res.send({ members: await staffOf(shopId) })
    } catch (error) {
        next(createError(500, error as Error))
    }
}
