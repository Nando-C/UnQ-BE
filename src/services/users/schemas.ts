import { z } from "zod"
import { email } from "../auth/schemas"

export const editMeSchema = z.object({
    name: z.string().min(1).optional(),
    surname: z.string().min(1).optional(),
    email: email.optional(),
    password: z.string().min(8).optional(),
    // Required to change the email or password of an account that has one.
    currentPassword: z.string().min(1).optional(),
})

// Required when the account has a password.
export const deleteMeSchema = z.object({
    currentPassword: z.string().min(1).optional(),
})
