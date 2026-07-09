import { jest, describe, it, expect } from "@jest/globals"
// Aliased with a `mock` prefix so the jest.mock factory (hoisted above imports) is
// allowed to reference it.
import { Writable as mockWritable } from "stream"

type Done = (err?: Error | null) => void

// Mock the Cloudinary SDK before the app (and therefore src/settings/cloudinary.ts)
// is imported, so no network call is ever made. `upload_stream` returns a Writable
// that consumes the piped file and then invokes the storage-engine callback with a
// fake result — mirroring the real streaming upload the custom StorageEngine drives.
jest.mock("cloudinary", () => ({
    v2: {
        uploader: {
            upload_stream: (_opts: unknown, cb: (err: unknown, result: unknown) => void) =>
                new mockWritable({
                    write(_chunk: Buffer, _enc: BufferEncoding, done: Done) {
                        done()
                    },
                    final(done: Done) {
                        cb(null, {
                            secure_url: "https://res.cloudinary.example/fake.jpg",
                            public_id: "fake",
                            bytes: 123,
                        })
                        done()
                    },
                }),
            destroy: jest.fn(),
        },
    },
}))

import request from "supertest"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"

describe("uploads", () => {
    it("stores the Cloudinary secure_url as the user's avatar", async () => {
        const { cookies } = await authFor("customer")

        const res = await request(app)
            .put("/users/me/avatar")
            .set("Cookie", cookies)
            .attach("avatar", Buffer.from("fake-image-bytes"), "a.jpg")

        expect(res.status).toBe(200)
        expect(res.body.avatar).toBe("https://res.cloudinary.example/fake.jpg")
    })
})
