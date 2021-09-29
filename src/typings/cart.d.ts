import { Document, Schema } from "mongoose";

export interface ICart {
    shopId: Schema.Types.ObjectId
    tableId: string
    status: string
    items: IItem[]
    split: ISplitItem[]
}

export interface IItem {
    menuId: Schema.Types.ObjectId
    qty: number
    // totalPriceItems: number
}

export interface ISplitItem {
    userId: Schema.Types.ObjectId
    menuId: Schema.Types.ObjectId
    qty: number
    splitStatus: string
    // total_price_items: number
}

export interface ICartDocument extends Document, ICart {}