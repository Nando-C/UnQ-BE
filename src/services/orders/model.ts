import mongoose from "mongoose"
import { IOrderDocument } from "src/typings/order"
import { PAYMENT_PROVIDERS, PAYMENT_STATUSES, REFUND_REASONS, REFUND_STATUSES } from "../carts/model"

const { Schema, model } = mongoose

// A diner's payment as a sales record (see IOrder): one per cart payment, built
// from the cart by syncOrder (services/orders/sync.ts) after every save that
// changes the payment or a refund of it. The cart stays the source of truth;
// an order outlives it, its table, its menu items and its shop. The sales
// report reads it (shops/controllers/salesControllers.ts).
const OrderSchema = new Schema<IOrderDocument>(
    {
        paymentId: { type: Schema.Types.ObjectId, required: true },
        cartId: { type: Schema.Types.ObjectId, required: true },
        cartOpenedAt: { type: Date, required: true },
        cartVersion: { type: Number, required: true },
        shopId: { type: Schema.Types.ObjectId, required: true },
        tableId: { type: String, required: true },
        tableName: String,
        payerId: { type: Schema.Types.ObjectId, required: true },
        status: { type: String, enum: PAYMENT_STATUSES, required: true },
        paidAt: { type: Date, required: true },
        currency: { type: String, required: true },
        amount: { type: Number, required: true },
        provider: { type: String, enum: PAYMENT_PROVIDERS, required: true },
        providerCheckoutId: { type: String, required: true },
        providerPaymentId: String,
        lines: [
            {
                _id: false,
                menuId: { type: Schema.Types.ObjectId, required: true },
                name: { type: String, required: true },
                category: { type: String, default: null },
                unitPrice: { type: Number, required: true },
                qty: { type: Number, required: true },
                refundedQty: { type: Number, required: true },
            },
        ],
        refunds: [
            {
                _id: false,
                refundId: { type: Schema.Types.ObjectId, required: true },
                status: { type: String, enum: REFUND_STATUSES, required: true },
                at: { type: Date, required: true },
                amount: { type: Number, required: true },
                lines: [
                    {
                        _id: false,
                        menuId: { type: Schema.Types.ObjectId, required: true },
                        name: { type: String, required: true },
                        qty: { type: Number, required: true },
                    },
                ],
                reason: { type: String, enum: REFUND_REASONS },
                reasonNote: String,
            },
        ],
    },
    // No timestamps: a sync that changes nothing must leave the order as it is
    // (the repair script counts those as unchanged). `paidAt` dates it.
)

// One order per payment: a retried or repeated sync can never double one.
OrderSchema.index({ paymentId: 1 }, { unique: true })
// The sales report: a shop's orders paid in a period, its refunds made in a
// period (a refund counts on the day it was made), and whether a payer had
// paid there before (repeat customers).
OrderSchema.index({ shopId: 1, paidAt: 1 })
OrderSchema.index({ shopId: 1, "refunds.at": 1 })
OrderSchema.index({ shopId: 1, payerId: 1, paidAt: 1 })

export default model<IOrderDocument>("Order", OrderSchema)
