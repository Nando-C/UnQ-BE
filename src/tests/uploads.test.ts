import { jest, describe, it, expect, beforeEach } from "@jest/globals"
// Aliased with a `mock` prefix so the jest.mock factory (hoisted above imports) is
// allowed to reference it.
import { Writable as mockWritable } from "stream"

type Done = (err?: Error | null) => void

// Every image the fake Cloudinary received, and every one it was asked to
// delete (by public id). `mock` prefix for the same hoisting reason.
const mockUploads: string[] = []
const mockDestroy = jest.fn((publicId: string) => Promise.resolve({ result: "ok", publicId }))

// Mock the Cloudinary SDK before the app (and therefore src/settings/cloudinary.ts)
// is imported, so no network call is ever made. `upload_stream` returns a Writable
// that consumes the piped file and then invokes the storage-engine callback with a
// fake result — mirroring the real streaming upload the custom StorageEngine drives.
// Each upload gets its own public id in the requested folder, and a URL shaped
// like Cloudinary's, so replaced images can be recognised and deleted.
jest.mock("cloudinary", () => ({
    v2: {
        uploader: {
            upload_stream: (opts: { folder: string }, cb: (err: unknown, result: unknown) => void) =>
                new mockWritable({
                    write(_chunk: Buffer, _enc: BufferEncoding, done: Done) {
                        done()
                    },
                    final(done: Done) {
                        const publicId = `${opts.folder}/img-${mockUploads.length + 1}`
                        mockUploads.push(publicId)
                        cb(null, {
                            secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.jpg`,
                            public_id: publicId,
                            bytes: 123,
                        })
                        done()
                    },
                }),
            destroy: (publicId: string) => mockDestroy(publicId),
        },
    },
}))

import request from "supertest"
import "./setup"
import app from "../server"
import { authFor } from "./helpers"

const urlOf = (publicId: string) => `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.jpg`
const jpeg = Buffer.from("fake-image-bytes")

// Deletes are fired without waiting on them; let them run before asserting.
const settle = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
    mockUploads.length = 0
    mockDestroy.mockClear()
})

describe("uploads", () => {
    describe("avatar", () => {
        it("stores the Cloudinary secure_url as the user's avatar", async () => {
            const { cookies } = await authFor("customer")

            const res = await request(app)
                .put("/users/me/avatar")
                .set("Cookie", cookies)
                .attach("avatar", jpeg, "a.jpg")

            expect(res.status).toBe(200)
            expect(res.body.avatar).toBe(urlOf("UnQ-App/Users/img-1"))
        })

        it("deletes the previous avatar once the new one is saved", async () => {
            const { cookies } = await authFor("customer")
            await request(app).put("/users/me/avatar").set("Cookie", cookies).attach("avatar", jpeg, "a.jpg")

            const res = await request(app).put("/users/me/avatar").set("Cookie", cookies).attach("avatar", jpeg, "b.jpg")
            await settle()

            expect(res.body.avatar).toBe(urlOf("UnQ-App/Users/img-2"))
            expect(mockDestroy.mock.calls).toEqual([["UnQ-App/Users/img-1"]])
        })

        it("refuses a request with no image, keeping the current avatar", async () => {
            const { cookies } = await authFor("customer")
            await request(app).put("/users/me/avatar").set("Cookie", cookies).attach("avatar", jpeg, "a.jpg")

            const res = await request(app).put("/users/me/avatar").set("Cookie", cookies).field("name", "x")

            expect(res.status).toBe(400)
            const me = await request(app).get("/users/me").set("Cookie", cookies)
            expect(me.body.avatar).toBe(urlOf("UnQ-App/Users/img-1"))
        })

        it("refuses a file that isn't an image without uploading it", async () => {
            const { cookies } = await authFor("customer")

            const res = await request(app)
                .put("/users/me/avatar")
                .set("Cookie", cookies)
                .attach("avatar", Buffer.from("<svg onload=alert(1)>"), "a.svg")

            expect(res.status).toBe(400)
            expect(mockUploads).toEqual([])
        })

        it("refuses an image over 5 MB and deletes what reached Cloudinary", async () => {
            const { cookies } = await authFor("customer")

            const res = await request(app)
                .put("/users/me/avatar")
                .set("Cookie", cookies)
                .attach("avatar", Buffer.alloc(5 * 1024 * 1024 + 1), "big.jpg")
            await settle()

            expect(res.status).toBe(413)
            expect(mockUploads).toHaveLength(1) // the cut-off part did reach Cloudinary…
            expect(mockDestroy.mock.calls).toEqual([[mockUploads[0]]]) // …and was deleted
        })
    })

    describe("shop cover", () => {
        it("never uploads for a manager of another shop", async () => {
            const owner = await authFor("shopMg")
            const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
            const intruder = await authFor("shopMg")

            const res = await request(app)
                .put(`/shops/${shopId}/cover`)
                .set("Cookie", intruder.cookies)
                .attach("cover", jpeg, "c.jpg")

            expect(res.status).toBe(403)
            expect(mockUploads).toEqual([])
        })

        it("uploads for an administrator, who is no member of the shop", async () => {
            const owner = await authFor("shopMg")
            const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
            const admin = await authFor("admin")

            const res = await request(app)
                .put(`/shops/${shopId}/cover`)
                .set("Cookie", admin.cookies)
                .attach("cover", jpeg, "c.jpg")

            expect(res.status).toBe(200)
            expect(res.body.cover).toBe(urlOf("UnQ-App/Shops/img-1"))
        })

        it("replaces the cover, deleting the old upload but never the default", async () => {
            const owner = await authFor("shopMg")
            const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
            const upload = () =>
                request(app).put(`/shops/${shopId}/cover`).set("Cookie", owner.cookies).attach("cover", jpeg, "c.jpg")

            const first = await upload()
            await settle()
            expect(first.status).toBe(200)
            expect(first.body.cover).toBe(urlOf("UnQ-App/Shops/img-1"))
            expect(mockDestroy).not.toHaveBeenCalled() // the default cover isn't ours

            await upload()
            await settle()
            expect(mockDestroy.mock.calls).toEqual([["UnQ-App/Shops/img-1"]])
        })
    })

    describe("menu item image", () => {
        const menuItem = { name: "Espresso", short_description: "Strong", price: 2.5, category: "drinks" }

        it("never uploads for an item on another shop's menu", async () => {
            const victim = await authFor("shopMg")
            const victimShop = (await request(app).post("/shops").set("Cookie", victim.cookies).send({ name: "A" })).body._id
            const itemId = (await request(app).post(`/shops/${victimShop}/menu`).set("Cookie", victim.cookies).send(menuItem)).body._id
            const intruder = await authFor("shopMg")
            const ownShop = (await request(app).post("/shops").set("Cookie", intruder.cookies).send({ name: "B" })).body._id

            const res = await request(app)
                .put(`/shops/${ownShop}/menu/${itemId}/img`)
                .set("Cookie", intruder.cookies)
                .attach("image", jpeg, "i.jpg")

            expect(res.status).toBe(404)
            expect(mockUploads).toEqual([])
        })

        it("replaces the image, deleting the old upload", async () => {
            const owner = await authFor("shopMg")
            const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id
            const itemId = (await request(app).post(`/shops/${shopId}/menu`).set("Cookie", owner.cookies).send(menuItem)).body._id
            const upload = () =>
                request(app).put(`/shops/${shopId}/menu/${itemId}/img`).set("Cookie", owner.cookies).attach("image", jpeg, "i.jpg")

            await upload()
            const second = await upload()
            await settle()

            expect(second.status).toBe(200)
            expect(second.body.image).toBe(urlOf("UnQ-App/MenuItems/img-2"))
            expect(mockDestroy.mock.calls).toEqual([["UnQ-App/MenuItems/img-1"]])
        })
    })
})
