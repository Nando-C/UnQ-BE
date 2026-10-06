import { Document, Types } from "mongoose"
import { IRefund, PaymentProvider, PaymentStatus } from "./cart"

// One diner's payment as a sales record: the cart's payment (see ICart's
// `payments`) with what the sales report needs, kept after the cart, table,
// menu item or shop is gone. Built from the cart by syncOrder, never edited.
export interface IOrder {
    paymentId: Types.ObjectId // the cart payment's _id
    cartId: Types.ObjectId // a table visit: the orders sharing it
    cartOpenedAt: Date
    cartVersion: number // the cart's __v it was built from (see syncOrder)
    shopId: Types.ObjectId
    tableId: string
    tableName?: string // as it was when first written
    payerId: Types.ObjectId // never shown in reports
    status: PaymentStatus
    paidAt: Date
    currency: string
    amount: number
    provider: PaymentProvider
    providerCheckoutId: string
    providerPaymentId?: string
    lines: IOrderLine[]
    refunds: IOrderRefund[]
}

export interface IOrderLine {
    menuId: Types.ObjectId
    name: string
    category: string | null // when paid; null if unknown
    unitPrice: number
    qty: number
    refundedQty: number
}

// The cart's refund as the report reads it; `at` is the day it counts on.
export type IOrderRefund = Pick<IRefund, "status" | "at" | "amount" | "lines" | "reason" | "reasonNote"> & {
    refundId: Types.ObjectId
}

export interface IOrderDocument extends Document, IOrder {}
