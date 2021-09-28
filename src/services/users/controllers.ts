import { TController } from "../../typings/controllers"
import { IUserDocument } from "src/typings/users"
import createError from "http-errors"
import UserModel from "./model"

export const getMe: TController = async ( req, res, next) => {
    res.json(req.user)
}

export const editMe: TController = async ( req, res, next) => {
    const me = req.user as IUserDocument
    try {
        const modifiedUser = await me.updateOne(req.body)
        res.send(modifiedUser)
    } catch (error) {
        next(createError(500, "An Error ocurred while updating the user"))
    }
}

export const editMyAvatar: TController = async ( req, res, next) => {
    const me = req.user as IUserDocument
    try {
        me.avatar = req.file?.path
        await me.save()
        res.send(me)
    } catch (error) {
        next(createError(500, "An Error ocurred while updating the user's avatar"))
    }
}

export const deleteMe: TController = async ( req, res, next ) => {
    const me = req.user as IUserDocument
    try {
        await me.deleteOne()
        res.status(204).send()
    } catch (error) {
        next(createError(500, "An Error ocurred while deleting the user"))
    }
}