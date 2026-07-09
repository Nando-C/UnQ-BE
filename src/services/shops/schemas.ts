import { z } from "zod"

const shopFields = {
    name: z.string().min(1),
    bio: z.string().optional(),
    open_times: z.string().optional(),
    phone: z.number().optional(),
    web_URL: z.string().optional(),
}

export const createShopSchema = z.object(shopFields)

export const editShopSchema = z.object({
    ...shopFields,
    name: shopFields.name.optional(),
})

export const createTableSchema = z.object({
    name: z.string().min(1),
})

export const editTableSchema = z.object({
    name: z.string().min(1),
})
