import { z } from "zod"

const shopFields = {
    name: z.string().min(1),
    bio: z.string().optional(),
    open_times: z.string().optional(),
    phone: z.string().trim().max(30)
        .regex(/^[+\d\s\-().]*$/, "Phone number can only contain digits, spaces, dashes and brackets")
        .optional(),
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

// GET /shops/browse's query. An empty parameter counts as absent; a repeated
// one arrives as a list, and fails.
const absentIfEmpty = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema)
export const browseShopsSchema = z.object({
    q: z.string().trim().max(100).default(""),
    cursor: absentIfEmpty(z.string().regex(/^[0-9a-f]{24}$/i, "Not a shop id").optional()),
    limit: absentIfEmpty(
        z.string().regex(/^\d+$/, "Not a whole number").transform(Number).pipe(z.number().min(1).max(50)).default(20)
    ),
})
export type BrowseShopsQuery = z.infer<typeof browseShopsSchema>
