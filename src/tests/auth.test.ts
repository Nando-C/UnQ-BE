import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import "./setup"
import app from "../server"
import UserModel from "../services/users/model"
import { cookiesFrom } from "./helpers"
import { googleUserFor } from "../services/auth/oauth"
import type GoogleStrategy from "passport-google-oauth20"

const validUser = {
    name: "Ada",
    surname: "Lovelace",
    email: "ada@example.com",
    password: "password123",
}

const cookieNames = (res: request.Response) =>
    ((res.headers["set-cookie"] as unknown as string[] | undefined) || []).map(
        (c) => c.split("=")[0]
    )

describe("auth", () => {
    describe("POST /auth/register", () => {
        it("creates a user (201), sets auth cookies, and never leaks secrets", async () => {
            const res = await request(app).post("/auth/register").send(validUser)

            expect(res.status).toBe(201)
            expect(cookieNames(res)).toEqual(
                expect.arrayContaining(["accessToken", "refreshToken"])
            )
            expect(res.body.email).toBe(validUser.email)
            expect(res.body.role).toBe("customer")
            expect(res.body).not.toHaveProperty("password")
            expect(res.body).not.toHaveProperty("refreshToken")
            expect(res.body).not.toHaveProperty("__v")
        })

        it("ignores a client-supplied role (no privilege escalation)", async () => {
            const res = await request(app)
                .post("/auth/register")
                .send({ ...validUser, role: "shopMg" })

            expect(res.status).toBe(201)
            expect(res.body.role).toBe("customer")

            const stored = await UserModel.findById(res.body._id)
            expect(stored?.role).toBe("customer")
        })

        it("rejects a duplicate email with 409", async () => {
            await request(app).post("/auth/register").send(validUser)
            const res = await request(app).post("/auth/register").send(validUser)

            expect(res.status).toBe(409)
            expect(res.body.message).toMatch(/already registered/i)
        })

        it("rejects invalid input with 400 and validation details", async () => {
            const res = await request(app)
                .post("/auth/register")
                .send({ email: "not-an-email", password: "short" })

            expect(res.status).toBe(400)
            expect(res.body.message).toBe("Validation failed")
            expect(Array.isArray(res.body.details)).toBe(true)
        })
    })

    describe("POST /auth/login", () => {
        it("logs in with correct credentials", async () => {
            await request(app).post("/auth/register").send(validUser)

            const res = await request(app)
                .post("/auth/login")
                .send({ email: validUser.email, password: validUser.password })

            expect(res.status).toBe(200)
            expect(res.body.email).toBe(validUser.email)
            expect(cookieNames(res)).toEqual(
                expect.arrayContaining(["accessToken", "refreshToken"])
            )
        })

        it("rejects a wrong password with 401", async () => {
            await request(app).post("/auth/register").send(validUser)

            const res = await request(app)
                .post("/auth/login")
                .send({ email: validUser.email, password: "wrongpassword" })

            expect(res.status).toBe(401)
        })

        it("returns 401 (not 500) for a Google user that has no password", async () => {
            await new UserModel({
                name: "Grace",
                surname: "Hopper",
                email: "grace@example.com",
                googleId: "google-123",
            }).save()

            const res = await request(app)
                .post("/auth/login")
                .send({ email: "grace@example.com", password: "password123" })

            expect(res.status).toBe(401)
        })
    })

    describe("POST /auth/refreshToken", () => {
        it("rotates the refresh token and accepts the newly-issued one", async () => {
            const registerRes = await request(app)
                .post("/auth/register")
                .send(validUser)
            const firstCookies = cookiesFrom(registerRes)

            // JWT `iat` is second-resolution: tokens minted in the same second are
            // byte-identical, which would mask a rotation regression. Space them out.
            await new Promise((r) => setTimeout(r, 1100))

            const firstRefresh = await request(app)
                .post("/auth/refreshToken")
                .set("Cookie", firstCookies)
            expect(firstRefresh.status).toBe(200)

            const rotatedCookies = cookiesFrom(firstRefresh)
            const newRefresh = rotatedCookies.find((c) =>
                c.startsWith("refreshToken=")
            )
            const oldRefresh = firstCookies.find((c) =>
                c.startsWith("refreshToken=")
            )
            expect(newRefresh).toBeDefined()
            expect(newRefresh).not.toBe(oldRefresh)

            // Regression for S1: the freshly-issued refresh cookie must work.
            const secondRefresh = await request(app)
                .post("/auth/refreshToken")
                .set("Cookie", rotatedCookies)
            expect(secondRefresh.status).toBe(200)
        })

        it("rejects a rotated-out (stale) refresh token with 401", async () => {
            const registerRes = await request(app)
                .post("/auth/register")
                .send(validUser)
            const firstCookies = cookiesFrom(registerRes)

            await new Promise((r) => setTimeout(r, 1100))

            const firstRefresh = await request(app)
                .post("/auth/refreshToken")
                .set("Cookie", firstCookies)
            expect(firstRefresh.status).toBe(200)

            // Reusing the original cookie after rotation must be rejected.
            const reuse = await request(app)
                .post("/auth/refreshToken")
                .set("Cookie", firstCookies)
            expect(reuse.status).toBe(401)
        })

        it("returns 401 (not 500) for an invalid or expired refresh token", async () => {
            const res = await request(app)
                .post("/auth/refreshToken")
                .set("Cookie", ["refreshToken=not-a-jwt"])
            expect(res.status).toBe(401)
            // The session is over, so the cookies are cleared, cross-site too.
            const setCookie = (res.headers["set-cookie"] as unknown as string[] | undefined) || []
            expect(setCookie).toHaveLength(2)
            for (const c of setCookie) expect(c).toMatch(/Expires=Thu, 01 Jan 1970.*Secure.*SameSite=None/)
        })

        it("returns 400 when no refresh token is provided", async () => {
            const res = await request(app).post("/auth/refreshToken")
            expect(res.status).toBe(400)
        })
    })

    describe("GET /auth/logout", () => {
        it("clears the auth cookies", async () => {
            const registerRes = await request(app)
                .post("/auth/register")
                .send(validUser)
            const cookies = cookiesFrom(registerRes)

            const res = await request(app)
                .get("/auth/logout")
                .set("Cookie", cookies)

            expect(res.status).toBe(204)
            const setCookie =
                (res.headers["set-cookie"] as unknown as string[] | undefined) || []
            expect(setCookie.join(";")).toMatch(/accessToken=/)
            expect(setCookie.join(";")).toMatch(/refreshToken=/)
        })
    })
})

// What Google hands the strategy after a sign-in.
const googleProfile = (email: string, verified = true) =>
    ({
        id: "google-42",
        name: { givenName: "Ada", familyName: "Lovelace" },
        emails: [{ value: email, verified }],
        photos: [{ value: "https://lh3.googleusercontent.example/ada.jpg" }],
    }) as unknown as GoogleStrategy.Profile

describe("Google sign-in (googleUserFor)", () => {
    it("links Google to an existing password account with the same verified email", async () => {
        await request(app).post("/auth/register").send(validUser)

        const user = await googleUserFor(googleProfile(validUser.email))

        const all = await UserModel.find({ email: validUser.email })
        expect(all).toHaveLength(1)
        expect(String(user?._id)).toBe(String(all[0]._id))
        expect(all[0].googleId).toBe("google-42")
        // The password is gone: nothing proved whoever set it owned the
        // address, so only Google signs in now.
        expect(all[0].password).toBeUndefined()
        const login = await request(app).post("/auth/login").send({ email: validUser.email, password: validUser.password })
        expect(login.status).toBe(401)
        // And the next Google sign-in finds the same account by its googleId.
        expect(String((await googleUserFor(googleProfile(validUser.email)))?._id)).toBe(String(all[0]._id))
    })

    it("links an account registered with the address capitalised differently", async () => {
        await request(app).post("/auth/register").send({ ...validUser, email: "Ada@Example.com" })

        await googleUserFor(googleProfile("ada@example.com"))

        const all = await UserModel.find({})
        expect(all).toHaveLength(1)
        expect(all[0].googleId).toBe("google-42")
    })

    it("won't link when Google hasn't verified the email", async () => {
        await request(app).post("/auth/register").send(validUser)

        expect(await googleUserFor(googleProfile(validUser.email, false))).toBeNull()
        expect((await UserModel.findOne({ email: validUser.email }))?.googleId).toBeUndefined()
    })

    it("creates an account for a new email", async () => {
        const user = await googleUserFor(googleProfile("new@example.com"))

        expect(user?.email).toBe("new@example.com")
        expect(user?.googleId).toBe("google-42")
        expect(await UserModel.countDocuments({ email: "new@example.com" })).toBe(1)
    })

    it("creates an account when Google gives no family name, or no name at all", async () => {
        const noSurname = googleProfile("cher@example.com")
        noSurname.name = { givenName: "Cher" } as GoogleStrategy.Profile["name"]
        const user = await googleUserFor(noSurname)
        expect(user).toMatchObject({ name: "Cher", email: "cher@example.com" })
        expect(user?.surname).toBeUndefined()

        const noName = { ...googleProfile("prince@example.com"), id: "google-43", name: undefined }
        expect((await googleUserFor(noName))?.name).toBe("prince")
    })
})

describe("emails", () => {
    it("are stored lowercase, and log in however they're capitalised", async () => {
        const res = await request(app).post("/auth/register").send({ ...validUser, email: "  Ada@Example.COM " })
        expect(res.status).toBe(201)
        expect(res.body.email).toBe("ada@example.com")

        const login = await request(app).post("/auth/login").send({ email: "ADA@example.com", password: validUser.password })
        expect(login.status).toBe(200)
    })

    it("count as taken however they're capitalised", async () => {
        await request(app).post("/auth/register").send(validUser)
        const res = await request(app).post("/auth/register").send({ ...validUser, email: "ADA@example.com" })
        expect(res.status).toBe(409)
    })
})

describe("PUT /users/me", () => {
    const registered = async () => {
        const res = await request(app).post("/auth/register").send(validUser)
        return cookiesFrom(res)
    }

    it("changes the name without the current password, and says whether the account has one", async () => {
        const cookies = await registered()
        const res = await request(app).put("/users/me").set("Cookie", cookies)
            .send({ name: "Augusta", email: "ADA@example.com" })
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ name: "Augusta", email: "ada@example.com", hasPassword: true })
        expect(res.body).not.toHaveProperty("password")
    })

    it("needs the current password to change the email or password", async () => {
        const cookies = await registered()

        const none = await request(app).put("/users/me").set("Cookie", cookies).send({ email: "new@example.com" })
        expect(none.status).toBe(400)
        expect(none.body.message).toBe("Enter your current password to change your email or password")

        const wrong = await request(app).put("/users/me").set("Cookie", cookies)
            .send({ password: "newpassword1", currentPassword: "nope" })
        expect(wrong.status).toBe(403)
        expect(wrong.body.message).toBe("Your current password is incorrect")

        const stored = await UserModel.findOne({ email: validUser.email })
        expect(stored).not.toBeNull()
        expect((await request(app).post("/auth/login").send({ email: validUser.email, password: validUser.password })).status).toBe(200)
    })

    it("changes the email with the current password", async () => {
        const cookies = await registered()
        const res = await request(app).put("/users/me").set("Cookie", cookies)
            .send({ email: "new@example.com", currentPassword: validUser.password })
        expect(res.status).toBe(200)
        expect(res.body.email).toBe("new@example.com")
    })

    it("answers 409 for an email another account has", async () => {
        await request(app).post("/auth/register").send({ ...validUser, email: "taken@example.com" })
        const cookies = await registered()
        const res = await request(app).put("/users/me").set("Cookie", cookies)
            .send({ email: "Taken@example.com", currentPassword: validUser.password })
        expect(res.status).toBe(409)
        expect(res.body.message).toBe("Email already registered")
    })

    it("a new password ends the other sessions and keeps this one", async () => {
        const cookies = await registered()
        const other = cookiesFrom(await request(app).post("/auth/login").send({ email: validUser.email, password: validUser.password }))

        const res = await request(app).put("/users/me").set("Cookie", other)
            .send({ password: "newpassword1", currentPassword: validUser.password })
        expect(res.status).toBe(200)

        // The session that changed it got fresh tokens that refresh.
        expect((await request(app).post("/auth/refreshToken").set("Cookie", cookiesFrom(res))).status).toBe(200)
        // An older one can't refresh any more.
        expect((await request(app).post("/auth/refreshToken").set("Cookie", cookies)).status).toBe(401)
        // Only the new password logs in.
        expect((await request(app).post("/auth/login").send({ email: validUser.email, password: validUser.password })).status).toBe(401)
        expect((await request(app).post("/auth/login").send({ email: validUser.email, password: "newpassword1" })).status).toBe(200)
    })

    it("won't give a Google-only account a password", async () => {
        await googleUserFor(googleProfile("g@example.com"))
        const user = await UserModel.findOne({ email: "g@example.com" })
        const { getTokens } = await import("../services/auth/tools")
        const { accessToken } = await getTokens(user!)
        const cookies = [`accessToken=${accessToken}`]

        const me = await request(app).get("/users/me").set("Cookie", cookies)
        expect(me.body.hasPassword).toBe(false)
        const res = await request(app).put("/users/me").set("Cookie", cookies).send({ password: "newpassword1" })
        expect(res.status).toBe(403)
        expect(res.body.message).toBe("This account signs in with Google, so it can't have a password")
        expect((await request(app).post("/auth/login").send({ email: "g@example.com", password: "newpassword1" })).status).toBe(401)
        // It can still change its name.
        expect((await request(app).put("/users/me").set("Cookie", cookies).send({ name: "Augusta" })).status).toBe(200)
    })
})

describe("DELETE /users/me", () => {
    it("needs the current password of an account that has one", async () => {
        const cookies = cookiesFrom(await request(app).post("/auth/register").send(validUser))

        expect((await request(app).delete("/users/me").set("Cookie", cookies)).status).toBe(400)
        expect((await request(app).delete("/users/me").set("Cookie", cookies).send({ currentPassword: "nope" })).status).toBe(403)
        expect(await UserModel.countDocuments({ email: validUser.email })).toBe(1)

        const res = await request(app).delete("/users/me").set("Cookie", cookies).send({ currentPassword: validUser.password })
        expect(res.status).toBe(204)
        expect(await UserModel.countDocuments({ email: validUser.email })).toBe(0)
    })
})
