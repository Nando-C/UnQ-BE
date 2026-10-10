import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import "./setup"
import app from "../server"
import env from "../settings/env"
import { quiet } from "./helpers"

// settings/cors.ts: which origins may call the API from a browser.

describe("CORS", () => {
    it("allows the front end's origins, with credentials", async () => {
        const origin = env.CORS_WHITELIST[0]
        const res = await request(app).get("/health").set("Origin", origin)
        expect(res.status).toBe(200)
        expect(res.headers["access-control-allow-origin"]).toBe(origin)
        expect(res.headers["access-control-allow-credentials"]).toBe("true")
    })

    // Swagger UI at /docs calls the API on the server's own origin, which
    // isn't a front-end origin.
    it("allows the server's own origin", async () => {
        const res = await request(app).get("/health").set("Host", "api.example.test").set("Origin", "http://api.example.test")
        expect(res.status).toBe(200)
        expect(res.headers["access-control-allow-origin"]).toBe("http://api.example.test")
    })

    it("allows a request with no Origin header", async () => {
        const res = await request(app).get("/health")
        expect(res.status).toBe(200)
        expect(res.headers["access-control-allow-origin"]).toBeUndefined()
    })

    it("refuses any other origin", async () => {
        const errors = quiet()
        const res = await request(app).get("/health").set("Host", "api.example.test").set("Origin", "https://evil.example")
        expect(res.status).toBe(500)
        expect(res.headers["access-control-allow-origin"]).toBeUndefined()
        expect(errors).toHaveBeenCalled()
        errors.mockRestore()
    })
})
