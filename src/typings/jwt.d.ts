import { IUserDocument } from "./users"

export interface IJWTPayload {
    _id: IUserDocument["_id"]
    // The session (device) the token belongs to: a user's sessions[]._id.
    sid: string
}
