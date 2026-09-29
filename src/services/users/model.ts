import mongoose from "mongoose"
import { IUserDocument, IUserModel } from "src/typings/users"
import * as bcrypt from 'bcrypt';

const { Schema, model } = mongoose

const UserSchema = new Schema<IUserDocument, IUserModel>(
    {
        name: {
            type: String,
            required: true,
        },
        surname: {
            type: String,
            required: true,
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
        password: {
            type: String,
            // required: true,
        },
        avatar: String,
        role: {
            type: String,
            enum: ["customer", "shopMg"],
            default: "customer"
        },
        refreshToken: String,
        googleId: String,
    },
    { timestamps: true }
)

// Mongoose 9: async middleware signals completion by resolving — there is no `next`.
UserSchema.pre("save", async function () {
    if (this.isModified("password") && this.password) this.password = await bcrypt.hash(this.password!, 10)
})

UserSchema.statics.checkCredentials = async function (email, password) {
    const user = await this.findOne({email})
    if (!user || !user.password) return null
    const isMatch = await bcrypt.compare(password, user.password)
    if (isMatch) return user
    return null
}

UserSchema.methods.toJSON = function () {
    const user = this.toObject()
    delete user.__v
    delete user.refreshToken
    // Whether the account can log in with a password (a Google-only one
    // can't): changing its email or password then asks for it.
    user.hasPassword = Boolean(user.password)
    delete user.password
    return user
}

export default model<IUserDocument, IUserModel>("User", UserSchema)