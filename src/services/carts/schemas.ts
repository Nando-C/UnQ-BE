import { z } from "zod"
import mongoose from "mongoose"
import { REFUND_REASONS } from "./model"

const objectId = (name: string) =>
    z.string().refine(mongoose.isValidObjectId, { message: `${name} must be a valid Mongo ObjectId` })

const menuId = objectId("menuId")
const qty = z.number().int().positive()

export const cartItemSchema = z.object({ menuId })

export const cartItemWithQtySchema = z.object({ menuId, qty })

// A manager releasing selections: everyone's, one diner's, or one item's.
// userId null: the selections of diners whose account no longer exists.
export const releaseSelectionSchema = z.object({ userId: objectId("userId").nullable().optional(), menuId: menuId.optional() })

// A manager refunding units of one payment: each item once, at least one; why
// (optional, so a client that doesn't send it still works), with a note only
// for "other".
export const refundSchema = z.object({
    paymentId: objectId("paymentId"),
    lines: z.array(z.object({ menuId, qty }))
        .min(1)
        .refine((lines) => new Set(lines.map((l) => l.menuId)).size === lines.length, { message: "List each item once" }),
    reason: z.enum(REFUND_REASONS).optional(),
    reasonNote: z.string().trim().min(1, "Say what happened").max(200).optional(),
}).superRefine((body, ctx) => {
    if (body.reason === "other" && !body.reasonNote) {
        ctx.addIssue({ code: "custom", path: ["reasonNote"], message: "Say what happened" })
    }
    if (body.reasonNote && body.reason !== "other") {
        ctx.addIssue({ code: "custom", path: ["reasonNote"], message: "A note goes with the reason Other only" })
    }
})

export const checkOutSplitSchema = z.object({ paypalOrderId: z.string().min(1) })

// A Stripe PaymentIntent's id.
export const stripeCaptureSchema = z.object({ paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9_]+$/, "paymentIntentId must be a PaymentIntent id") })
