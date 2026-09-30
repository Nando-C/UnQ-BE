import { Document, Types } from "mongoose"

export interface IShop {
    name: string
    cover: string
    bio: string
    open_times: string
    phone?: string
    web_URL: string
    shopMg: Types.ObjectId[]
    tables: ITable[]
    // Tables the manager deleted: they take no orders and diners never see them,
    // but their recent carts stay reachable (see deleteTable).
    deletedTables: IDeletedTable[]
    menu: Types.ObjectId[]
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