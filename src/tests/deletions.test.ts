import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import "./setup"
import app from "../server"
import { authFor, cookiesFrom } from "./helpers"
import CartModel from "../services/carts/model"
import MenuModel from "../services/menus/model"
import ShopModel from "../services/shops/model"
import UserModel from "../services/users/model"
import { refreshTokens } from "../services/auth/tools"

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

// Closes the cart as paid by Ada, the payment and (optionally) a refund of it
// in the given states.
const closePaid = async (
    cartId: string,
    dinerId: unknown,
    latte: string,
    { payment = "completed", refund }: { payment?: "completed" | "pending"; refund?: "pending" | "completed" } = {}
) => {
    await CartModel.updateOne({ _id: cartId }, {
        $set: { status: "closed", "items.0.qtyPayed": 1 },
        $push: {
            payments: {
                provider: "paypal", status: payment, providerCheckoutId: "ORDER-1", providerPaymentId: "CAP-1", currency: "GBP",
                userId: dinerId, paidAt: new Date(), amount: 3,
                lines: [{ menuId: latte, name: "Latte", qty: 1, unitPrice: 3 }],
            },
        },
    })
    if (!refund) return
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
        await closePaid(cartId, ada.user._id, latte)
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
        expect(res.body.message).toBe("A payment or refund in this shop is still awaiting PayPal — check it first")
        expect(await ShopModel.exists({ _id: shopId })).not.toBeNull()
        expect(await CartModel.countDocuments({ _id: cartId })).toBe(1)
    })

    it("is refused while a payment is still waiting on PayPal", async () => {
        const { owner, shopId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { payment: "pending" })

        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(409)
    })

    it("goes ahead once the refund has settled", async () => {
        const { owner, shopId, latte, ada, cartId } = await scaffold()
        await closePaid(cartId, ada.user._id, latte, { refund: "completed" })

        expect((await request(app).delete(`/shops/${shopId}`).set("Cookie", owner.cookies)).status).toBe(204)
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
        const stored = (await UserModel.findOne({ email }))!.refreshToken
        expect(stored).toBe(issued[0].refreshToken)
    })
})
