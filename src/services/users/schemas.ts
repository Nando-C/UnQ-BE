import { z } from "zod"
import { email, password } from "../auth/schemas"
import { emptyAsAbsent } from "../../lib/emptyAsAbsent"
import { ACCOUNT_ROLES } from "./model"

export const editMeSchema = z.object({
    name: z.string().min(1).optional(),
    surname: z.string().min(1).optional(),
    email: email.optional(),
    password: password.optional(),
    // Required to change the email or password of an account that has one.
    currentPassword: z.string().min(1).optional(),
})

// Required when the account has a password.
export const deleteMeSchema = z.object({
    currentPassword: z.string().min(1).optional(),
})

// An administrator's account routes (users/routes.ts).
export const createUserSchema = z.object({
    name: z.string().min(1),
    surname: z.string().min(1),
    email,
    password,
    role: z.enum(ACCOUNT_ROLES).default("customer"),
})

export const setRoleSchema = z.object({
    role: z.enum(ACCOUNT_ROLES),
})

// GET /users' query. An empty parameter counts as absent.
export const listUsersSchema = z.object({
    q: z.string().trim().max(100).default(""),
    role: z.preprocess(emptyAsAbsent, z.enum(ACCOUNT_ROLES).optional()),
    page: z.preprocess(emptyAsAbsent, z.string().regex(/^\d+$/, "Not a whole number").transform(Number).pipe(z.number().min(1)).default(1)),
    limit: z.preprocess(emptyAsAbsent, z.string().regex(/^\d+$/, "Not a whole number").transform(Number).pipe(z.number().min(1).max(50)).default(20)),
})
export type ListUsersQuery = z.infer<typeof listUsersSchema>
