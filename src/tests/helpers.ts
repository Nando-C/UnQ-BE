import { jest } from "@jest/globals"
import { Response } from "supertest"
import request from "supertest"
import app from "../server"
import UserModel from "../services/users/model"

// Reduce each Set-Cookie header to its `name=value` pair so it can be replayed as a
// Cookie request header (the app sets Secure/SameSite=None cookies that supertest's
// http agent would otherwise drop).
export const cookiesFrom = (res: Response): string[] => {
    const raw = res.headers["set-cookie"] as unknown as string[] | undefined
    if (!raw) return []
    return raw.map((c) => c.split(";")[0])
}

export const agent = () => request(app)

// Create a user directly (/register can't set a role) so tests can mint a
// `shopMg`. The pre-save hook hashes `password`, so the same value logs in.
export const createUser = async (overrides: Partial<{
    name: string
    surname: string
    email: string
    password: string
    role: "customer" | "shopMg"
}> = {}) => {
    const data = {
        name: "Test",
        surname: "User",
        email: `user-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
        password: "password123",
        role: "customer" as const,
        ...overrides,
    }
    const user = await new UserModel(data).save()
    return { user, password: data.password, email: data.email }
}

// Log in and return the auth cookies for a user created via createUser().
export const loginCookies = async (email: string, password: string): Promise<string[]> => {
    const res = await request(app).post("/auth/login").send({ email, password })
    return cookiesFrom(res)
}

// Server errors a test expects, muted (the spy, to assert on them).
export const quiet = () => jest.spyOn(console, "error").mockImplementation(() => {})

// Convenience: create a user with a role and return usable auth cookies.
export const authFor = async (role: "customer" | "shopMg" = "customer") => {
    const { user, email, password } = await createUser({ role })
    const cookies = await loginCookies(email, password)
    return { user, email, password, cookies }
}
