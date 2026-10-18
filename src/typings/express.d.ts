import "express"
import { IUserDocument } from "./users"

declare global {
    namespace Express {
        interface Request {
            user?: IUserDocument
            // The session (device) the access token belongs to, set with `user`
            // (auth/middlewares.ts); a user's sessions[]._id.
            sessionId?: string
            // After isShopManager/isShopOwner: how the caller got through for
            // the shop in the URL (auth/middlewares.ts).
            shopRole?: "admin" | import("./shop").MemberRole
            // The body's bytes, for Stripe's webhook only (server.ts).
            rawBody?: Buffer
        }
    }
}
