import { Document, Types } from "mongoose"

export interface IShop {
    name: string
    cover: string
    bio: string
    open_times: string
    phone?: string
    web_URL: string
    timeZone: string // an IANA name; the days the sales report counts in
    // Every account with access to the shop (what the guards read), owner
    // included; kept in step with `members` by the same writes.
    shopMg: Types.ObjectId[]
    // The one member who can delete the shop. Absent on a shop no member has
    // opened since membership arrived (filled on demand, see membershipOf).
    ownerId?: Types.ObjectId
    // One per id in shopMg, with the role and when they joined.
    members: IMember[]
    tables: ITable[]
    // Tables the manager deleted: they take no orders and diners never see them,
    // but their recent carts stay reachable (see deleteTable).
    deletedTables: IDeletedTable[]
    menu: Types.ObjectId[]
}

// The roles a member can hold (shops/roles.ts MEMBER_ROLES).
export type { MemberRole } from "../services/shops/roles"
import type { MemberRole } from "../services/shops/roles"

export interface IMember {
    userId: Types.ObjectId
    role: MemberRole
    since: Date
    // Who added them; absent for a shop's first owner.
    addedBy?: Types.ObjectId
}

export interface ITable {
    _id: Types.ObjectId
    name: string
    Qr_Url: string
}

export interface IDeletedTable {
    _id: Types.ObjectId
    name: string
    deletedAt: Date
}

export interface IShopDocument extends Document, IShop {}