import { RequestHandler } from "express"
import { ZodType } from "zod"
import createError from "http-errors"

export const validate = (schema: ZodType): RequestHandler => (req, res, next) => {
    const result = schema.safeParse(req.body)

    if (!result.success) {
        const details = result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
        }))
        return next(createError(400, "Validation failed", { details }))
    }

    req.body = result.data
    next()
}
