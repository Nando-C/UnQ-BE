import { Document, Schema } from "mongoose"

export interface IShop {
    name: string
    cover: string
    bio: string
    open_times: string
    phone: number
    web_URL: string
    shopMg: Schema.Types.ObjectId[]
    tables: ITable[]
    menu: IMenuItem[]
}

export interface ITable {
    _id: Schema.Types.ObjectId
    name: string
    Qr_Url: string
}

export interface IMenuItem {
    name: string
    image: string
    short_description: string
    description: string
    price: number
    available: boolean
    category: string
}

export interface IShopDocument extends Document, IShop {}