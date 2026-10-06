import { RequestHandler } from "express"
import { ZodType } from "zod"
import createError from "http-errors"

// Route middleware: checks req.body against `schema` and replaces it with the
// parsed result (trimmed, defaulted, unknown keys dropped). With "query", checks
// req.query instead, and leaves the result in res.locals.query (Express 5's
// req.query can't be replaced). A bad one gets a 400 whose `details` lists
// each problem as { path, message }.
export const validate = (schema: ZodType, source: "body" | "query" = "body"): RequestHandler => (req, res, next) => {
    const result = schema.safeParse(req[source])

    if (!result.success) {
        const details = result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        return next(createError(400, "Validation failed", { details }))
    }

    if (source === "query") res.locals.query = result.data
    else req.body = result.data
    next()
}
