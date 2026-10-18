import mongoose from "mongoose"
import { ISession, IUserDocument, IUserModel } from "src/typings/users"
import * as bcrypt from 'bcrypt';
import { limitedPasswordCheck } from "../../lib/passwordLimit"
import env from "../../settings/env"

const { Schema, model } = mongoose

// The account roles (docs/auth.md#roles-and-ownership).
export const ACCOUNT_ROLES = ["customer", "shopMg", "admin"] as const

// One signed-in device: the id of the refresh token it holds (never the token
// itself), and of the one it held before its last rotation (see auth/tools.ts).
const SessionSchema = new Schema<ISession>({
    jti: { type: String, required: true },
    previousJti: String,
    rotatedAt: Date,
    createdAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true },
    userAgent: String,
})

const UserSchema = new Schema<IUserDocument, IUserModel>(
    {
        name: {
            type: String,
            required: true,
        },
        // Google may not give one, so a Google account can be without it.
        surname: {
            type: String,
            required: function (this: IUserDocument) { return !this.googleId },
        },
        // Stored lowercase and trimmed, and lookups by email are cast the same
        // way, so an address matches however it's capitalised.
        email: {
            type: String,
            unique: true,
            required: true,
            lowercase: true,
            trim: true,
        },
        // Hashed on save. None for an account that only signs in with Google.
        password: {
            type: String,
        },
        avatar: String,
        // "shopMg" (shop manager) can create shops for themselves; "admin" can
        // do everything on every shop and manage accounts. Neither is taken
        // from a request body: an administrator gives them, or the database.
        role: {
            type: String,
            enum: ACCOUNT_ROLES,
            default: "customer"
        },

        // The devices signed in, one refresh token each (see auth/tools.ts).
        sessions: { type: [SessionSchema], default: [] },
        // Looked up on every Google sign-in.
        googleId: { type: String, index: { sparse: true } },
        // Who made the account when it wasn't the person: an administrator
        // (POST /users) or a shop's owner adding staff (POST /shops/:shopId/staff).
        // Absent on a self-registered one.
        createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    },
    { timestamps: true }
)

// Mongoose 9: async middleware signals completion by resolving — there is no `next`.
UserSchema.pre("save", async function () {
    if (this.isModified("password") && this.password) this.password = await bcrypt.hash(this.password!, env.BCRYPT_ROUNDS)
})

UserSchema.statics.checkCredentials = async function (email, password) {
    const user = await this.findOne({email})
    if (!user || !user.password) return null
    const hash = user.password
    const right = await limitedPasswordCheck(String(user._id), () => bcrypt.compare(password, hash))
    if (right === "locked") return "locked"
    return right ? user : null
}

UserSchema.methods.toJSON = function () {
    const user = this.toObject()
    delete user.__v
    delete user.sessions
    // Whether the account can log in with a password (a Google-only one
    // can't): changing its email or password then asks for it.
    user.hasPassword = Boolean(user.password)
    delete user.password
    return user
}

const UserModel = model<IUserDocument, IUserModel>("User", UserSchema)
export default UserModel

// Administrators can do everything on every shop; no shop guard refuses them.
export const isAdmin = (user: Pick<IUserDocument, "role">) => user.role === "admin"