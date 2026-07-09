import { z } from "zod"

const menuItemFields = {
    name: z.string().min(1),
    short_description: z.string().min(1),
    description: z.string().optional(),
    price: z.number().positive(),
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
