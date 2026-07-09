import "express"
import { IUserDocument } from "./users"

declare global {
    namespace Express {
        interface Request {
            user?: IUserDocument
        }
    }
}