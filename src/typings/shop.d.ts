import { Document, Types } from "mongoose"

export interface IShop {
    name: string
    cover: string
    bio: string
    open_times: string
    phone: number
    web_URL: string
    shopMg: Types.ObjectId[]
    tables: ITable[]
    menu: Types.ObjectId[]
}

export interface ITable {
    _id: Types.ObjectId
    name: string
    Qr_Url: string
}

export interface IShopDocument extends Document, IShop {}