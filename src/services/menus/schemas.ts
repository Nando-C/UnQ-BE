import { z } from "zod"

const menuItemFields = {
    name: z.string().min(1),
    short_description: z.string().min(1),
    description: z.string().optional(),
    // Whole pence: refunds price each line on its own, so a fraction of a
    // penny would make them add up to more than the checkout charged.
    price: z.number().positive().multipleOf(0.01, "Price must be in whole pence (at most 2 decimals)"),
    available: z.boolean().optional(),
    category: z.enum(["food", "drinks"]),
}

export const createMenuItemSchema = z.object(menuItemFields)

export const editMenuItemSchema = z.object({
    ...menuItemFields,
    name: menuItemFields.name.optional(),
    short_description: menuItemFields.short_description.optional(),
    price: menuItemFields.price.optional(),
    category: menuItemFields.category.optional(),
})
