import { z } from "zod"
import mongoose from "mongoose"

const menuId = z.string().refine(mongoose.isValidObjectId, { message: "menuId must be a valid Mongo ObjectId" })
const qty = z.number().int().positive()

export const cartItemSchema = z.object({ menuId })

export const cartItemWithQtySchema = z.object({ menuId, qty })

const objectId = (name: string) =>
    z.string().refine(mongoose.isValidObjectId, { message: `${name} must be a valid Mongo ObjectId` })

// A manager releasing selections: everyone's, one diner's, or one item's.
export const releaseSelectionSchema = z.object({ userId: objectId("userId").optional(), menuId: objectId("menuId").optional() })

export const checkOutSplitSchema = z.object({ paypalOrderId: z.string().min(1) })
