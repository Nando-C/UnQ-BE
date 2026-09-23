import { Document, Types } from "mongoose";

export interface ICart {
    userId: Types.ObjectId
    shopId?: Types.ObjectId
    tableId: string
    status: string
    items: IItem[]
    split: ISplitItem[]
    paypalOrderId?: string // legacy scalar, read-only for pre-multi-payer carts
    paypalOrderIds?: string[] // one recorded PayPal order per payer
}

export interface IItem {
    menuId: Types.ObjectId
    qty: number
    qtyPayed: number
}

export interface ISplitItem {
    userId: Types.ObjectId
    menuId: Types.ObjectId
    qty: number
    splitStatus: string
}

export interface ICartDocument extends Document, ICart {}