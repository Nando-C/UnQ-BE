import "express"
import { IUserDocument } from "./users"

declare global {
    namespace Express {
        interface Request {
            user?: IUserDocument
            // The session (device) the access token belongs to, set with `user`
            // (auth/middlewares.ts); a user's sessions[]._id.
            sessionId?: string
            // The body's bytes, for Stripe's webhook only (server.ts).
            rawBody?: Buffer
        }
    }
}
