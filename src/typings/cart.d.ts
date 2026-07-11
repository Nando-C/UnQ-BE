import { Document, Schema } from "mongoose";

export interface ICart {
    userId: Schema.Types.ObjectId
    shopId?: Schema.Types.ObjectId
    tableId: string
    status: string
    items: IItem[]
    split: ISplitItem[]
    paypalOrderId?: string
}

export interface IItem {
    menuId: Schema.Types.ObjectId
    qty: number
    qtyPayed: number
}

export interface ISplitItem {
    userId: Schema.Types.ObjectId
    menuId: Schema.Types.ObjectId
    qty: number
    splitStatus: string
}

export interface ICartDocument extends Document, ICart {}