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
    payments: IPayment[] // manager-only: never in a diner response (see model toJSON)
}

// One settled checkout: what a payer paid, when, and at what prices. Written in
// the same save that settles it. Payments made before these records existed
// have none (their closed splits have no unitPrice either). Provider-neutral:
// only `provider` says whose ids the two provider* fields are.
export type PaymentProvider = "paypal"

export interface IPayment {
    _id?: Types.ObjectId // set by Mongoose on push
    provider: PaymentProvider
    providerCheckoutId: string
    providerPaymentId?: string
    currency: string
    userId: Types.ObjectId
    paidAt: Date
    amount: number
    lines: IPaymentLine[]
}

export interface IPaymentLine {
    menuId: Types.ObjectId
    name: string
    qty: number
    unitPrice: number
    refundedQty: number
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
    // Set when the split is paid: the price charged per unit, and when.
    unitPrice?: number
    paidAt?: Date
}

export interface ICartDocument extends Document, ICart {}