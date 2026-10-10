import { rateLimit } from "express-rate-limit"
import createError from "http-errors"
import env from "../settings/env"
import { IUserDocument } from "../typings/users"

// Limits count per account, not per IP (the wrong-password one too, in
// lib/passwordLimit.ts): behind the front-end's Vercel rewrite and Render's
// proxies the server can't reliably tell visitors' addresses apart (a venue's
// diners share one anyway). Counts live in this process's memory, so they
// restart with it; several servers would need a shared store (e.g. Redis).

// Changes to a table's order per diner (after JWTAuthMiddleware), counted
// before validate, so malformed requests count too. Starting a card checkout
// counts too (each makes a Stripe intent); capturing is never limited: a
// refused capture would leave an approved or authorised payment unfinished.
export const cartEditLimit = rateLimit({
    standardHeaders: "draft-8",
    legacyHeaders: false,
    windowMs: 60 * 1000,
    limit: env.CART_EDITS_PER_MINUTE,
    keyGenerator: (req) => `user:${(req.user as IUserDocument)._id}`,
    // A 429 with a message, through errorsHandler like any error.
    handler: (req, res, next) => next(createError(429, "Too many changes to your order — wait a minute and try again")),
})
