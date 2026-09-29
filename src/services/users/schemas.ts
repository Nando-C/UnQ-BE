import { z } from "zod"

// Trimmed and lowercased before it's checked, as the user model stores it.
const email = z.string().trim().toLowerCase().pipe(z.email())

export const editMeSchema = z.object({
    name: z.string().min(1).optional(),
    surname: z.string().min(1).optional(),
    email: email.optional(),
    password: z.string().min(8).optional(),
    // Required to change the email or password of an account that has one.
    currentPassword: z.string().min(1).optional(),
})
