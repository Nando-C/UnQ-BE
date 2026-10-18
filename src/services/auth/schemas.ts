import { z } from "zod"

// Trimmed and lowercased before it's checked, as the user model stores it.
export const email = z.string().trim().toLowerCase().pipe(z.email())

// One rule wherever a password is set: register, profile edit, and the
// accounts an administrator or a shop's staff create.
export const password = z.string().min(8)

export const registerSchema = z.object({
    name: z.string().min(1),
    surname: z.string().min(1),
    email,
    password,
})

export const loginSchema = z.object({
    email,
    password: z.string().min(1),
})
