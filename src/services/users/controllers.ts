import { TController } from "../../typings/controllers"
import { IUserDocument } from "src/typings/users"
import createError from "http-errors"

// -------------------------------------------------------------------------

export const getMe: TController = async ( req, res, next) => {
    res.json(req.user)
}

// -------------------------------------------------------------------------

export const editMe: TController = async ( req, res, next) => {
    const me = req.user as IUserDocument
    try {
        const { name, surname, email, password } = req.body
        if (name !== undefined) me.name = name
        if (surname !== undefined) me.surname = surname
        if (email !== undefined) me.email = email
        if (password !== undefined) me.password = password

        await me.save()
        res.send(me)
    } catch (error) {
        next(createError(500, "An Error ocurred while updating the user"))
    }
}

// -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------

export const deleteMe: TController = async ( req, res, next ) => {
    const me = req.user as IUserDocument
    try {
        await me.deleteOne()
        res.status(204).send()
    } catch (error) {
        next(createError(500, "An Error ocurred while deleting the user"))
    }
}

// -------------------------------------------------------------------------