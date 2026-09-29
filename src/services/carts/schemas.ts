import { z } from "zod"
import mongoose from "mongoose"

const objectId = (name: string) =>
    z.string().refine(mongoose.isValidObjectId, { message: `${name} must be a valid Mongo ObjectId` })

const menuId = objectId("menuId")
const qty = z.number().int().positive()

export const cartItemSchema = z.object({ menuId })

export const cartItemWithQtySchema = z.object({ menuId, qty })

// A manager releasing selections: everyone's, one diner's, or one item's.
// userId null: the selections of diners whose account no longer exists.
export const releaseSelectionSchema = z.object({ userId: objectId("userId").nullable().optional(), menuId: menuId.optional() })

// A manager refunding units of one payment: each item once, at least one.
export const refundSchema = z.object({
    paymentId: objectId("paymentId"),
    lines: z.array(z.object({ menuId, qty }))
        .min(1)
        .refine((lines) => new Set(lines.map((l) => l.menuId)).size === lines.length, { message: "List each item once" }),
})

export const checkOutSplitSchema = z.object({ paypalOrderId: z.string().min(1) })
