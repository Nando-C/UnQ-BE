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
    stripePaymentIntentIds?: string[] // one recorded Stripe PaymentIntent per payer
    payments: IPayment[] // manager-only: never in a diner response (see model dinerView)
    refunds: IRefund[] // manager-only
    notices: INotice[]
    managerLog: IManagerLogEntry[] // manager-only
}

// A manager's refund of some units of a payment (see the model's comment).
export interface IRefund {
    _id?: Types.ObjectId // set by Mongoose on push
    paymentId: Types.ObjectId
    lines: { menuId: Types.ObjectId; name: string; qty: number }[]
    amount: number
    currency: string
    status: (typeof import("../services/carts/model").REFUND_STATUSES)[number]
    providerRefundId?: string
    failureReason?: string
    byUserId: Types.ObjectId
    at: Date
    // Why the manager refunded (absent on older refunds, or from an older
    // client); `reasonNote` only with "other".
    reason?: RefundReason
    reasonNote?: string
}

// From the one list, in services/carts/model.ts.
export type RefundReason = import("../services/carts/model").RefundReason

// A note to the table's diners about a manager's change; `forUserId` makes it
// one diner's.
export interface INotice {
    _id?: Types.ObjectId | string // a string: a card payment's outcome (stripeCheckout.ts)
    at: Date
    forUserId?: Types.ObjectId
    message: string
}

export interface IManagerLogEntry {
    at: Date
    byUserId?: Types.ObjectId // none: written by the server itself (the Stripe sweep or webhook)
    action: string
    details?: string
}

// From the lists in services/carts/model.ts.
export type PaymentProvider = (typeof import("../services/carts/model").PAYMENT_PROVIDERS)[number]
// See the model: pending until the provider confirms it.
export type PaymentStatus = (typeof import("../services/carts/model").PAYMENT_STATUSES)[number]

// One settled checkout: what a payer paid, when, and at what prices. Written in
// the same save that settles it. Payments made before these records existed
// have none (their closed splits have no unitPrice either). Provider-neutral:
// only `provider` says whose ids the two provider* fields are.
export interface IPayment {
    _id?: Types.ObjectId // set by Mongoose on push
    provider: PaymentProvider
    status: PaymentStatus
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
    // The item's category when paid (absent on lines paid before it was kept).
    category?: string
}

// A line of the table's order: `qty` units of a menu item, `qtyPayed` of them
// paid for. (The spelling is part of the API.)
export interface IItem {
    menuId: Types.ObjectId
    qty: number
    qtyPayed: number
}

// A diner's share of a line: "open" while selected to pay, "closed" once paid.
export interface ISplitItem {
    userId: Types.ObjectId
    menuId: Types.ObjectId
    qty: number
    splitStatus: string
    // Set when the split is paid: the price charged per unit, and when.
    unitPrice?: number
    paidAt?: Date
    claimedAt?: Date // when first selected
}

export interface ICartDocument extends Document, ICart {}