import { Document, Schema } from "mongoose"
// import { IMenuDocument } from "./menu";

export interface IShop {
    name: string
    cover: string
    bio: string
    open_times: string
    phone: number
    web_URL: string
    shopMg: Schema.Types.ObjectId[]
    tables: ITable[]
    menu: Schema.Types.ObjectId[]
}

export interface ITable {
    _id: Schema.Types.ObjectId
    name: string
    Qr_Url: string
}

export interface IShopDocument extends Document, IShop {}