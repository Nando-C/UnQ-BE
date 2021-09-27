import mongoose from "mongoose"
import { IUserDocument, IUserModel } from "src/typings/users"
import bcrypt from "bcrypt"

const { Schema, model } = mongoose

const UserSchema = new Schema<IUserDocument,IUserModel>(
    {
        name: {
            type: String,
            required: true,
        },
        surname: {
            type: String,
            required: true,
        },
        email: {
            type: String,
            unique: true,
            required: true,
        },
        password: {
            type: String,
            // required: true,
        },
        avatar: String,
        role: {
            type: String,
            enum: ["customer", "storeMg"],
            default: "customer"
        },
        refreshToken: String,
    },
    { timestamps: true }
)

UserSchema.pre("save", async function (next) {
    if (this.isModified("password")) this.password = await bcrypt.hash(this.password!, 10)
    next()
})

UserSchema.statics.checkCredentials = async function (email, password) {
    const user = await this.findOne({email})
    if (!user) return
    const isMatch = await bcrypt.compare(password, user.password!)
    if (isMatch) return user
}

UserSchema.methods.toJSON = function () {
    const user = this.toObject()
    delete user.__v
    delete user.refreshToken
    delete user.password
    return user
}

export default model<IUserDocument, IUserModel>("User", UserSchema)