import { z } from "zod"

// Trimmed and lowercased before it's checked, as the user model stores it.
export const email = z.string().trim().toLowerCase().pipe(z.email())

export const registerSchema = z.object({
    name: z.string().min(1),
    surname: z.string().min(1),
    email,
    password: z.string().min(8),
})

export const loginSchema = z.object({
    email,
    password: z.string().min(1),
})
