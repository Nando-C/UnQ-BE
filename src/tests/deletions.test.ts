import { jest, describe, it, expect } from "@jest/globals"

// PayPal mocked at the module boundary, before the app is imported.
jest.mock("../lib/paypal", () => ({
    getOrder: jest.fn(),
    createOrder: jest.fn(),
    captureOrder: jest.fn(),
    refundCapture: jest.fn(),
    findRefund: jest.fn(),
    PayPalRefundRefused: jest.requireActual<typeof import("../lib/paypal")>("../lib/paypal").PayPalRefundRefused,
    PayPalCaptureRefused: jest.requireActual<typeof import("../lib/paypal")>("../lib/paypal").PayPalCaptureRefused,
}))

import request from "supertest"
import "./setup"
import app from "../server"
import { authFor, cookiesFrom } from "./helpers"
import CartModel from "../services/carts/model"
import MenuModel from "../services/menus/model"
import ShopModel from "../services/shops/model"
import UserModel from "../services/users/model"
import { refreshTokens } from "../services/auth/tools"
import jwt from "jsonwebtoken"
import { refundCapture } from "../lib/paypal"

// A shop with a £3 Latte and a £2 Muffin, one table, and Ada's cart at it
// holding a Latte.
const scaffold = async () => {
    const owner = await authFor("shopMg")
    const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id as string
    const tableId = (await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name: "T1" })).body._id as string
    const item = async (name: string, price: number) =>
        (await request(app).post(`/shops/${shopId}/menu`).set("Cookie", owner.cookies)
            .send({ name, short_description: "x", price, category: "drinks" })).body._id as string
    const latte = await item("Latte", 3)
    const muffin = await item("Muffin", 2)
    const ada = await authFor("customer")
    const add = (menuId: string, table = tableId) =>
        request(app).post(`/carts/${shopId}/tables/${table}/addItem`).set("Cookie", ada.cookies).send({ menuId, qty: 1 })
    const cartId = (await add(latte)).body._id as string
    return { owner, shopId, tableId, latte, muffin, ada, add, cartId }
}

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600_000)

// Closes the cart as paid by Ada, the payment and (optionally) a refund of it
// in the given states.
const closePaid = async (
    cartId: string,
    dinerId: unknown,
    latte: string,
    { payment = "completed", refund, paidAt = new Date(), closedAt }:
        { payment?: "completed" | "pending" | "failed"; refund?: "pending" | "completed"; paidAt?: Date; closedAt?: Date } = {}
) => {
    await CartModel.updateOne({ _id: cartId }, {
        $set: { status: "closed", "items.0.qtyPayed": 1 },
        $push: {
            payments: {
                provider: "paypal", status: payment, providerCheckoutId: "ORDER-1", providerPaymentId: "CAP-1", currency: "GBP",
                userId: dinerId, paidAt, amount: 3,
                lines: [{ menuId: latte, name: "Latte", qty: 1, unitPrice: 3 }],
            },
        },
    })
    if (refund) {
        const paymentId = (await CartModel.findById(cartId))!.payments[0]._id
        await CartModel.updateOne({ _id: cartId }, {
            $push: {
                refunds: {
                    paymentId, lines: [{ menuId: latte, name: "Latte", qty: 1 }], amount: 3, currency: "GBP",
                    status: refund, byUserId: dinerId, at: new Date(),
                },
            },
        })
    }
    if (closedAt) await ageCart(cartId, closedAt)
}

// Dates the cart's last change, as if it closed then.
const ageCart = async (cartId: string, at: Date) => {
    const oid = (await CartModel.findById(cartId))!._id
    await CartModel.collection.updateOne({ _id: oid }, { $set: { updatedAt: at } })
}

describe("deleting a menu item", () => {
    it("takes it off the menu, and carts that hold it still name it (sold out)", async () => {
        const { owner, shopId, tableId, latte } = await scaffold()

        expect((await request(app).delete(`/shops/${shopId}/menu/${latte}`).set("Cookie", owner.cookies)).status).toBe(204)

        const shop = await request(app).get(`/shops/${shopId}`)
        expect(shop.body.menu.map((m: { name: string }) => m.name)).toEqual(["Muffin"])
        const cart = await request(app).get(`/carts/tables/${tableId}`)
        expect(cart.body.items[0].menuId).toMatchObject({ _id: latte, name: "Latte", available: false })
    })

    it("can't be ordered, read, edited or deleted again", async () => {
        const { owner, shopId, latte, add } = await scaffold()
        await request(app).delete(`/shops/${shopId}/menu/${latte}`).set("Cookie", owner.cookies)

        expect((await add(latte)).status).toBe(404)
        expect((await request(app).get(`/shops/${shopId}/menu/${latte}`).set("Cookie", owner.cookies)).status).toBe(404)
        expect((await request(app).put(`/shops/${shopId}/menu/${latte}`).set("Cookie", owner.cookies).send({ price: 4 })).status).toBe(404)
        expect((await request(app).delete(`/shops/${shopId}/menu/${latte}`).set("Cookie", owner.cookies)).status).toBe(404)
    })
})

describe("deleting a table", () => {
    it("lists it among the shop's deleted tables, whose recent carts the manager can still open", async () => {
        const { owner, shopId, tableId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte)

        expect((await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)).status).toBe(204)

        const mine = (await request(app).get("/shops/me").set("Cookie", owner.cookies)).body[0]
        expect(mine.tables).toEqual([])
        expect(mine.deletedTables).toEqual([
            expect.objectContaining({ _id: tableId, name: "T1", deletedAt: expect.any(String) }),
        ])
        const carts = await request(app).get(`/shops/${shopId}/tables/${tableId}/carts`).set("Cookie", owner.cookies)
        expect(carts.status).toBe(200)
        expect(carts.body.recentlyClosed.map((c: { _id: string }) => c._id)).toEqual([cartId])
    })

    it("stops taking orders, and isn't shown to diners", async () => {
        const { owner, shopId, tableId, latte, ada, cartId, add } = await scaffold()
        await closePaid(cartId, ada.user._id, latte)
        await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)

        expect((await add(latte)).status).toBe(404)
        expect((await request(app).get(`/shops/${shopId}/tables/${tableId}`)).status).toBe(404)
        expect((await request(app).get(`/shops/${shopId}`)).body).not.toHaveProperty("deletedTables")
        expect((await request(app).get("/shops/")).body[0]).not.toHaveProperty("deletedTables")
    })

    it("is recorded once, and its name can be used again", async () => {
        const { owner, shopId, tableId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte)
        const remove = () => request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)

        expect((await remove()).status).toBe(204)
        expect((await remove()).status).toBe(204)
        expect((await ShopModel.findById(shopId))!.deletedTables).toHaveLength(1)
        expect((await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name: "T1" })).status).toBe(200)
    })
})

describe("deleting a shop", () => {
    it("deletes its menu items, deleted ones too, and its carts", async () => {
        const { owner, shopId, tableId, latte, muffin, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { paidAt: daysAgo(2), closedAt: daysAgo(2) })
        await request(app).delete(`/shops/${shopId}/menu/${muffin}`).set("Cookie", owner.cookies)
        await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)

        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)

        expect(await ShopModel.exists({ _id: shopId })).toBeNull()
        expect(await MenuModel.countDocuments({ _id: { $in: [latte, muffin] } })).toBe(0)
        expect(await CartModel.countDocuments({ _id: cartId })).toBe(0)
    })

    it("leaves other shops' menu items and carts alone", async () => {
        const first = await scaffold()
        const other = await scaffold()

        expect((await request(app).delete(`/shops/${first.shopId}`).set("Cookie", first.owner.cookies)).status).toBe(409) // open cart
        await CartModel.updateOne({ _id: first.cartId }, { status: "closed" })
        expect((await request(app).delete(`/shops/${first.shopId}`).set("Cookie", first.owner.cookies)).status).toBe(204)

        expect(await MenuModel.countDocuments({ _id: { $in: [other.latte, other.muffin] } })).toBe(2)
        expect(await CartModel.countDocuments({ _id: other.cartId })).toBe(1)
    })

    it("is refused while a refund is still waiting on PayPal", async () => {
        const { owner, shopId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { refund: "pending" })

        const res = await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)

        expect(res.status).toBe(409)
        expect(res.body.message).toBe("A payment or refund at table T1 is still awaiting PayPal — check it there first")
        expect(await ShopModel.exists({ _id: shopId })).not.toBeNull()
        expect(await CartModel.countDocuments({ _id: cartId })).toBe(1)
    })

    it("is refused while a payment is still waiting on PayPal", async () => {
        const { owner, shopId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { payment: "pending" })

        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(409)
    })

    it("is refused for a day after a paid cart closes, so it can still be refunded", async () => {
        const { owner, shopId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { paidAt: daysAgo(0.5) })

        const res = await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)

        expect(res.status).toBe(409)
        expect(res.body.message).toBe(
            "A payment at table T1 can still be refunded from its sheet: the shop can be deleted once no paid cart has changed for a day"
        )
        expect(await CartModel.countDocuments({ _id: cartId })).toBe(1)
    })

    it("is refused while a cart paid earlier closed in the last 24 hours (it's still on its table's sheet)", async () => {
        const { owner, shopId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { paidAt: daysAgo(2) })

        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(409)
    })

    it("isn't held back by a payment already refunded in full", async () => {
        const { owner, shopId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { refund: "completed" })
        await CartModel.updateOne({ _id: cartId }, { $set: { "payments.0.lines.0.refundedQty": 1 } })

        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)
    })

    it("is held back by a payment recorded before payments had a status", async () => {
        const { owner, shopId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte)
        const oid = (await CartModel.findById(cartId))!._id
        await CartModel.collection.updateOne({ _id: oid }, { $unset: { "payments.0.status": "" } })

        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(409)
    })

    it("isn't held back by a payment with no capture id (only PayPal can refund it)", async () => {
        const { owner, shopId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte)
        await CartModel.updateOne({ _id: cartId }, { $unset: { "payments.0.providerPaymentId": "" } })

        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)
    })

    it("isn't held back by a payment that failed (nothing to refund)", async () => {
        const { owner, shopId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { payment: "failed" })

        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)
    })

    it("goes ahead once the refund has settled", async () => {
        const { owner, shopId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { refund: "completed", paidAt: daysAgo(2), closedAt: daysAgo(2) })

        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)
    })
})

describe("money still waiting on PayPal, and deleted tables", () => {
    it("refunds an older cart (from before carts recorded their shop) at a deleted table", async () => {
        jest.mocked(refundCapture).mockResolvedValue("REF-1")
        const { owner, shopId, tableId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte)
        await CartModel.collection.updateOne({ _id: (await CartModel.findById(cartId))!._id }, { $unset: { shopId: "" } })
        await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)
        const paymentId = String((await CartModel.findById(cartId))!.payments[0]._id)

        const res = await request(app).post(`/shops/${shopId}/carts/${cartId}/refunds`).set("Cookie", owner.cookies)
            .send({ paymentId, lines: [{ menuId: latte, qty: 1 }] })

        expect(res.status).toBe(200)
    })

    it("keeps a table whose cart opened while it was being deleted", async () => {
        const { owner, shopId, tableId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte)
        // A diner's order lands just after the check for an open cart.
        const move = ShopModel.updateOne.bind(ShopModel)
        const spy = jest.spyOn(ShopModel, "updateOne").mockImplementationOnce(((...args: Parameters<typeof move>) =>
            move(...args).then(async (result) => {
                await CartModel.updateOne({ _id: cartId }, { status: "open" })
                return result
            })) as never)

        const res = await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)
        spy.mockRestore()

        expect(res.status).toBe(409)
        const shop = (await ShopModel.findById(shopId))!
        expect(shop.tables.map((t) => String(t._id))).toEqual([tableId])
        expect(shop.deletedTables).toHaveLength(0)
    })

    it("lets the manager close an open cart left at a deleted table", async () => {
        const { owner, shopId, tableId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { paidAt: daysAgo(2) })
        await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)
        await CartModel.updateOne({ _id: cartId }, { status: "open" })

        const close = await request(app).post(`/shops/${shopId}/tables/${tableId}/carts/${cartId}/close`).set("Cookie", owner.cookies)

        expect(close.status).toBe(200)
        // Its payment stays refundable for a day after it closed.
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(409)
        await ageCart(cartId, daysAgo(2))
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)
    })

    it("refuses to delete a table while its money is still waiting on PayPal", async () => {
        const { owner, shopId, tableId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { refund: "pending" })

        const res = await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)

        expect(res.status).toBe(409)
        expect(res.body.message).toBe("A payment or refund at this table is still awaiting PayPal — check it first")
    })

    it("keeps showing an older cart whose refund is still waiting, and flags its deleted table", async () => {
        const { owner, shopId, tableId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte)
        await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)
        // Refunded from the deleted table's sheet; PayPal never answered. Days later:
        await closePaid(cartId, ada.user._id, latte, { refund: "pending" })
        const oid = (await CartModel.findById(cartId))!._id
        await CartModel.collection.updateOne({ _id: oid }, { $set: { updatedAt: daysAgo(3) } })
        await ShopModel.updateOne({ _id: shopId }, { $set: { "deletedTables.0.deletedAt": daysAgo(3) } })

        const carts = await request(app).get(`/shops/${shopId}/tables/${tableId}/carts`).set("Cookie", owner.cookies)
        expect(carts.body.recentlyClosed.map((c: { _id: string }) => c._id)).toEqual([cartId])
        const mine = (await request(app).get("/shops/me").set("Cookie", owner.cookies)).body[0]
        expect(mine.deletedTables[0]).toMatchObject({ _id: tableId, needsAttention: true })
    })

    it("doesn't flag a deleted table with nothing left to do", async () => {
        const { owner, shopId, tableId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte)
        await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)

        const mine = (await request(app).get("/shops/me").set("Cookie", owner.cookies)).body[0]
        expect(mine.deletedTables[0]).not.toHaveProperty("needsAttention")
    })
})

describe("refreshing one session from two tabs at once", () => {
    it("rotates the token once: one tab gets the new pair, the other is told it was superseded", async () => {
        const { email, password } = await authFor("customer").then(async (a) => ({ email: a.email, password: a.password }))
        const login = await request(app).post("/auth/login").send({ email, password })
        const token = cookiesFrom(login).find((c) => c.startsWith("refreshToken="))!.split("=")[1]

        const results = await Promise.all([refreshTokens(token), refreshTokens(token)])

        const issued = results.filter((r) => typeof r === "object" && r !== null) as { refreshToken: string }[]
        expect(issued).toHaveLength(1)
        expect(results).toContain("superseded")
        // This device's session holds the id of the token that won, and the old one as replaced.
        const old = (jwt.decode(token) as jwt.JwtPayload).jti
        const session = (await UserModel.findOne({ email }))!.sessions.find((s) => s.previousJti === old)
        expect(session?.jti).toBe((jwt.decode(issued[0].refreshToken) as jwt.JwtPayload).jti)
    })
})

describe("which deleted tables still have carts to show", () => {
    it("flags one whose cart closed in the last 24 hours, and not once that's older", async () => {
        const { owner, shopId, tableId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte)
        await request(app).delete(`/shops/${shopId}/tables/${tableId}`).set("Cookie", owner.cookies)
        const deleted = async () => (await request(app).get("/shops/me").set("Cookie", owner.cookies)).body[0].deletedTables[0]

        // Until a day after the cart's last change, when it leaves the sheet.
        const closed = (await CartModel.findById(cartId))!.get("updatedAt") as Date
        const listed = await deleted()
        expect(listed._id).toBe(tableId)
        expect(Date.parse(listed.recentCartsUntil)).toBe(closed.getTime() + 24 * 3600_000)

        await ageCart(cartId, daysAgo(2))
        expect(await deleted()).not.toHaveProperty("recentCartsUntil")
    })
})

describe("taking the last unit off a cart a manager acted on", () => {
    it("keeps the cart, closed, with the manager's log", async () => {
        const { shopId, tableId, latte, ada, cartId } = await scaffold()
        await CartModel.updateOne({ _id: cartId }, {
            $push: { managerLog: { at: new Date(), byUserId: ada.user._id, action: "release", details: "x" } },
        })

        const res = await request(app).post(`/carts/${shopId}/tables/${tableId}/removeItem`).set("Cookie", ada.cookies)
            .send({ menuId: latte, qty: 1 })

        expect(res.status).toBe(200)
        const cart = await CartModel.findById(cartId)
        expect(cart?.status).toBe("closed")
        expect(cart?.managerLog).toHaveLength(1)
    })
})

describe("deleting a manager's account", () => {
    it("is refused while they still have shops, and ends the session once it goes", async () => {
        const { owner, shopId } = await scaffold()
        const remove = () => request(app).delete("/users/me").set("Cookie", owner.cookies).send({ currentPassword: owner.password })

        const refused = await remove()
        expect(refused.status).toBe(409)
        expect(refused.body.message).toBe("Delete your shops first")
        expect(await UserModel.exists({ _id: owner.user._id })).not.toBeNull()

        await CartModel.deleteMany({})
        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)
        const done = await remove()
        expect(done.status).toBe(204)
        const cleared = (done.headers["set-cookie"] as unknown as string[]).map((c) => c.split("=")[0])
        expect(cleared).toEqual(expect.arrayContaining(["accessToken", "refreshToken"]))
    })
})
