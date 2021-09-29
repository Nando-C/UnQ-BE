import { Document, Schema } from "mongoose"

export interface IShop {
    name: string
    cover: string
    bio: string
    open_times: string
    phone: number
    web_URL: string
    shopMg: Schema.Types.ObjectId[]
    tables: [
        {
            id: string
            Qr_Url: string
        }
    ]
    menu: IMenuItem[]
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