// First, before anything reads the settings: the real limits, not the test setup's.
import "./realLimits"
import { describe, it, expect, beforeAll, jest } from "@jest/globals"
import request from "supertest"
import mongoose from "mongoose"
import "./setup"
import app from "../server"
import { authFor, createUser } from "./helpers"
import env from "../settings/env"
import UserModel from "../services/users/model"
import { accountsCounted, limitedPasswordCheck, TOO_MANY_WRONG_PASSWORDS } from "../lib/passwordLimit"

beforeAll(() => {
    // Fails here, plainly, if the settings were read before realLimits ran.
    expect([env.PASSWORD_FAILS_PER_ACCOUNT, env.CART_EDITS_PER_MINUTE, env.PEOPLE_ADDED_PER_HOUR]).toEqual([10, 120, 20])
})

const signIn = (email: string, password: string) => request(app).post("/auth/login").send({ email, password })
const wrongTimes = async (n: number, email: string) => {
    for (let i = 0; i < n; i++) expect((await signIn(email, "wrong-password")).status).toBe(401)
}

describe("people-added limit", () => {
    it("stops an account after 20 people added in an hour, across both routes", async () => {
        const admin = await authFor("admin")
        const owner = await authFor("shopMg")
        const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
        const stamp = Date.now()
        const person = (i: number) => ({ name: "P", surname: String(i), email: `p${i}-${stamp}@example.com`, password: "firstpass1" })

        for (let i = 0; i < 20; i++) expect((await request(app).post("/users").set("Cookie", admin.cookies).send(person(i))).status).toBe(201)
        const refused = await request(app).post("/users").set("Cookie", admin.cookies).send(person(20))
        expect([refused.status, refused.body.message]).toEqual([429, "Too many people added in an hour — wait a while and try again"])
        // The same count serves the staff route, and attaching counts too.
        expect((await request(app).post(`/shops/${shopId}/staff`).set("Cookie", admin.cookies).send({ email: person(0).email, role: "manager" })).status).toBe(429)
        // Another account's count is its own.
        expect((await request(app).post(`/shops/${shopId}/staff`).set("Cookie", owner.cookies).send({ email: person(0).email, role: "manager" })).status).toBe(200)
    })
})

describe("wrong-password limit", () => {
    it("locks an account after 10 wrong passwords, even for the right one; other accounts still sign in", async () => {
        const { email, password } = await createUser()
        const other = await createUser()
        await wrongTimes(10, email)

        const locked = await signIn(email, password)
        expect(locked.status).toBe(429)
        expect(locked.body.message).toBe(TOO_MANY_WRONG_PASSWORDS)
        expect((await signIn(other.email, other.password)).status).toBe(200)
    })

    it("counts an email however it's typed", async () => {
        const { email, password } = await createUser()
        for (let i = 0; i < 10; i++) await signIn(`  ${email.toUpperCase()} `, "wrong-password")

        expect((await signIn(email, password)).status).toBe(429)
    })

    it("doesn't count right passwords, and they don't clear wrong ones", async () => {
        const { email, password } = await createUser()
        for (let i = 0; i < 12; i++) expect((await signIn(email, password)).status).toBe(200)
        await wrongTimes(9, email)
        expect((await signIn(email, password)).status).toBe(200)
        await wrongTimes(1, email)

        expect((await signIn(email, password)).status).toBe(429)
    })

    it("keeps an account's count when its email changes", async () => {
        const { email, password, cookies } = await authFor("customer")
        await wrongTimes(5, email)
        const moved = await request(app).put("/users/me").set("Cookie", cookies).send({ email: "moved@example.com", currentPassword: password })
        expect(moved.status).toBe(200)
        await wrongTimes(5, "moved@example.com")

        expect((await signIn("moved@example.com", password)).status).toBe(429)
    })

    it("lets no more than 10 of a burst of guesses through", async () => {
        const { email } = await createUser()
        const answers = await Promise.all(Array.from({ length: 20 }, () => signIn(email, "wrong-password")))
        const statuses = answers.map((a) => a.status)

        expect(statuses.filter((s) => s === 401)).toHaveLength(10)
        expect(statuses.filter((s) => s === 429)).toHaveLength(10)
    })

    it("doesn't count a check that fails", async () => {
        const fault = async (): Promise<boolean> => { throw new Error("bcrypt failed") }
        for (let i = 0; i < 12; i++) await expect(limitedPasswordCheck("account-b", fault)).rejects.toThrow("bcrypt failed")

        for (let i = 0; i < 10; i++) expect(await limitedPasswordCheck("account-b", async () => false)).toBe(false)
        expect(await limitedPasswordCheck("account-b", async () => false)).toBe("locked")
    })

    it("doesn't count an email with no password to check: no account, or a Google-only one", async () => {
        const google = await new UserModel({ name: "Gus", email: "gus@example.com", googleId: "g-1" }).save()
        const before = accountsCounted()
        for (let i = 0; i < 12; i++) {
            expect((await signIn("nobody@example.com", "wrong-password")).status).toBe(401)
            expect((await signIn(google.email, "wrong-password")).status).toBe(401)
        }
        expect(accountsCounted()).toBe(before)
    })

    it("gives a check's count back to the window it came from", async () => {
        const now = jest.spyOn(Date, "now")
        const start = Date.now()
        now.mockReturnValue(start)
        let answer: (right: boolean) => void = () => {}
        const slow = limitedPasswordCheck("account-a", () => new Promise<boolean>((resolve) => { answer = resolve }))

        // The window ends while it's being checked; two wrong guesses in the next one.
        now.mockReturnValue(start + 16 * 60 * 1000)
        const wrong = () => limitedPasswordCheck("account-a", async () => false)
        await wrong()
        await wrong()
        answer(true)
        expect(await slow).toBe(true)

        // The next window still has its two, so 8 more and it's locked.
        for (let i = 0; i < 8; i++) expect(await wrong()).toBe(false)
        expect(await wrong()).toBe("locked")
        now.mockRestore()
    })

    it("counts wrong current passwords on the account's own routes too, but still lets it change its name", async () => {
        const { user, email, password, cookies } = await authFor("customer")
        await wrongTimes(5, email)
        for (let i = 0; i < 5; i++) {
            const guess = await request(app).put("/users/me").set("Cookie", cookies).send({ email: "new@example.com", currentPassword: "wrong-password" })
            expect(guess.status).toBe(403)
        }

        const deleting = await request(app).delete("/users/me").set("Cookie", cookies).send({ currentPassword: password })
        expect(deleting.status).toBe(429)
        expect(deleting.body.message).toBe(TOO_MANY_WRONG_PASSWORDS)
        expect(await UserModel.exists({ _id: user._id })).toBeTruthy()
        expect((await signIn(email, password)).status).toBe(429)
        expect((await request(app).put("/users/me").set("Cookie", cookies).send({ name: "Ana" })).status).toBe(200)
    })
})

describe("cart edit limit", () => {
    it("refuses a diner's 121st change in a minute, but not another diner's, nor checkout", async () => {
        const ana = await authFor("customer")
        const ben = await authFor("customer")
        const shopId = new mongoose.Types.ObjectId()
        const tableId = new mongoose.Types.ObjectId()
        const cartId = new mongoose.Types.ObjectId()
        // An empty body fails validation (400), after the change is counted.
        const edit = (cookies: string[], route = "addItem") =>
            request(app).post(`/carts/${shopId}/tables/${tableId}/${route}`).set("Cookie", cookies).send({})

        for (let i = 0; i < 120; i++) expect((await edit(ana.cookies)).status).toBe(400)

        const refused = await edit(ana.cookies)
        expect(refused.status).toBe(429)
        expect(refused.body.message).toBe("Too many changes to your order — wait a minute and try again")
        // One count across every way of changing the order.
        expect((await edit(ana.cookies, "deleteItem")).status).toBe(429)
        expect((await edit(ben.cookies)).status).toBe(400)

        const checkout = await request(app)
            .post(`/carts/tables/${tableId}/${cartId}/createCheckoutOrder`)
            .set("Cookie", ana.cookies)
        // Reaches checkout itself, which finds no such cart.
        expect(checkout.status).toBe(404)
        expect(checkout.body.message).toBe("Cart Not Found!")
    })
})
