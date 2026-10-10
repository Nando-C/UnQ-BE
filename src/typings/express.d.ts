import "express"
import { IUserDocument } from "./users"

declare global {
    namespace Express {
        interface Request {
            user?: IUserDocument
            // The body's bytes, for Stripe's webhook only (server.ts).
            rawBody?: Buffer
        }
    }
}