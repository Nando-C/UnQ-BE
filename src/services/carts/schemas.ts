import { z } from "zod"
import mongoose from "mongoose"

const menuId = z.string().refine(mongoose.isValidObjectId, { message: "menuId must be a valid Mongo ObjectId" })
const qty = z.number().int().positive()

export const cartItemSchema = z.object({ menuId })

export const cartItemWithQtySchema = z.object({ menuId, qty })
