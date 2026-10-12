import { z } from "zod"
import { emptyAsAbsent } from "../../lib/emptyAsAbsent"
import { isTimeZone } from "./model"
import { daysBetween, isDay } from "../../lib/days"

const shopFields = {
    name: z.string().min(1),
    bio: z.string().optional(),
    open_times: z.string().optional(),
    phone: z.string().trim().max(30)
        .regex(/^[+\d\s\-().]*$/, "Phone number can only contain digits, spaces, dashes and brackets")
        .optional(),
    web_URL: z.string().optional(),
    timeZone: z.string().refine(isTimeZone, "Not a time zone name (an IANA name, like Europe/London)").optional(),
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
export const browseShopsSchema = z.object({
    q: z.string().trim().max(100).default(""),
    cursor: z.preprocess(emptyAsAbsent, z.string().regex(/^[0-9a-f]{24}$/i, "Not a shop id").optional()),
    limit: z.preprocess(
        emptyAsAbsent,
        z.string().regex(/^\d+$/, "Not a whole number").transform(Number).pipe(z.number().min(1).max(50)).default(20)
    ),
})
export type BrowseShopsQuery = z.infer<typeof browseShopsSchema>

// GET /shops/:shopId/sales's query (see controllers/salesControllers.ts). The
// days are the shop's; `by` defaults from the range's length.
export const GROUP_BY = ["day", "week", "month"] as const
export const MAX_REPORT_DAYS = 366
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Not a day (YYYY-MM-DD)", abort: true }).refine(isDay, "Not a calendar day")
export const salesQuerySchema = z.object({
    from: day,
    to: day,
    by: z.preprocess(emptyAsAbsent, z.enum(GROUP_BY).optional()),
    compare: z.preprocess(emptyAsAbsent, z.enum(["previous"]).optional()),
})
    .refine((q) => !isDay(q.from) || !isDay(q.to) || q.from <= q.to, { message: "Before `from`", path: ["to"] })
    .refine((q) => !isDay(q.from) || !isDay(q.to) || daysBetween(q.from, q.to) <= MAX_REPORT_DAYS, { message: `More than ${MAX_REPORT_DAYS} days after \`from\``, path: ["to"] })
export type SalesQuery = z.infer<typeof salesQuerySchema>
