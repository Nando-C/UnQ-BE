import { z } from "zod"

export const editMeSchema = z.object({
    name: z.string().min(1).optional(),
    surname: z.string().min(1).optional(),
    email: z.email().optional(),
    password: z.string().min(8).optional(),
})
