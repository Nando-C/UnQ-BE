import { Document, Schema } from "mongoose";

export interface ICart {
    tableId: string
    status: string
    items: IItem[]
    split: ISplitItem[]
}

export interface IItem {
    itemId: Schema.Types.ObjectId
    qty: number
    // totalPriceItems: number
}

export interface ISplitItem {
    userId: Schema.Types.ObjectId
    itemId: Schema.Types.ObjectId
    qty: number
    splitStatus: string
    // total_price_items: number
}

export interface ICartDocument extends Document, ICart {}