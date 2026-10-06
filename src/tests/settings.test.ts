import { describe, it, expect } from "@jest/globals"
import { spawnSync } from "child_process"
import path from "path"
import "./setup"
import { createUser } from "./helpers"
import UserModel from "../services/users/model"

const ROOT = path.resolve(__dirname, "../..")

// The settings check runs at import and exits the process on a problem, so it
// runs here in a child process of its own: the test suite's settings, minus
// the cost and the Jest marker, which each case gives (or not) itself.
const load = (extra: Record<string, string>) => {
    const env = { ...process.env }
    delete env.BCRYPT_ROUNDS
    delete env.JEST_WORKER_ID
    const result = spawnSync(
        path.join(ROOT, "node_modules/.bin/tsx"),
        ["-e", `console.log("rounds=" + require(${JSON.stringify(path.join(ROOT, "src/settings/env"))}).default.BCRYPT_ROUNDS)`],
        { cwd: ROOT, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 }
    )
    if (result.error) throw result.error
    return { status: result.status, out: result.stdout + result.stderr }
}
const refused = (extra: Record<string, string>) => {
    const { status, out } = load(extra)
    return status === 1 && out.includes("BCRYPT_ROUNDS")
}

describe("BCRYPT_ROUNDS", () => {
    it("is 10 unless set, and takes 10 to 13 anywhere", () => {
        expect(load({})).toMatchObject({ status: 0, out: expect.stringContaining("rounds=10") })
        expect(load({ BCRYPT_ROUNDS: "" })).toMatchObject({ status: 0, out: expect.stringContaining("rounds=10") })
        expect(load({ BCRYPT_ROUNDS: "13" })).toMatchObject({ status: 0, out: expect.stringContaining("rounds=13") })
        expect(refused({ BCRYPT_ROUNDS: "14" })).toBe(true)
    })

    it("goes below 10 only inside the test suite, whatever NODE_ENV says", () => {
        expect(load({ BCRYPT_ROUNDS: "4", JEST_WORKER_ID: "1" })).toMatchObject({ status: 0, out: expect.stringContaining("rounds=4") })
        for (const NODE_ENV of ["test", "production", "development"]) {
            expect([NODE_ENV, refused({ BCRYPT_ROUNDS: "4", NODE_ENV })]).toEqual([NODE_ENV, true])
        }
        expect(refused({ BCRYPT_ROUNDS: "3", JEST_WORKER_ID: "1" })).toBe(true)
    })

    it("is reported with the other problems in one boot", () => {
        const both = load({ BCRYPT_ROUNDS: "4", MONGO_CONNECTION: "" })
        expect(both.status).toBe(1)
        expect(both.out).toContain("BCRYPT_ROUNDS")
        expect(both.out).toContain("MONGO_CONNECTION")
    })

    it("is the cost passwords are stored with", async () => {
        const { email } = await createUser()
        // bcrypt's hash names its cost: $2b$<cost>$… (the suite runs at 4).
        expect((await UserModel.findOne({ email }))!.password).toMatch(/^\$2b\$04\$/)
    })
})
