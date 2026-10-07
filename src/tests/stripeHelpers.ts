import request from "supertest"
import app from "../server"
import { authFor } from "./helpers"
import { fakeStripe } from "./fakeStripe"
import CartModel from "../services/carts/model"
import StripeCheckoutModel from "../services/carts/stripeCheckout"

// For the Stripe suites, which mock lib/stripe with fakeStripe. A shop with a
// table and an item (`qty` ordered at `price`), Ada's cart with `select` of
// them selected to pay, and the calls her checkout makes.
export const stripeTable = async ({ qty = 2, price = 3, select }: { qty?: number; price?: number; select?: number } = {}) => {
    const owner = await authFor("shopMg")
    const shopId = (await request(app).post("/shops").set("Cookie", owner.cookies).send({ name: "Cafe" })).body._id as string
    const tableId = (await request(app).post(`/shops/${shopId}/tables`).set("Cookie", owner.cookies).send({ name: "T1" })).body._id as string
    const latte = (await request(app).post(`/shops/${shopId}/menu`).set("Cookie", owner.cookies)
        .send({ name: "Latte", short_description: "x", price, category: "drinks" })).body._id as string
    const ada = await authFor("customer")
    const cartId = (await request(app).post(`/carts/${shopId}/tables/${tableId}/addItem`).set("Cookie", ada.cookies)
        .send({ menuId: latte, qty })).body._id as string
    type Diner = typeof ada
    const select_ = (who: Diner, q: number) =>
        request(app).post(`/carts/${shopId}/tables/${tableId}/${cartId}/addSplitItem`).set("Cookie", who.cookies).send({ menuId: latte, qty: q })
    if ((select ?? qty) > 0) await select_(ada, select ?? qty)

    const create = (who: Diner = ada, table = tableId) =>
        request(app).post(`/carts/tables/${table}/${cartId}/createStripeCheckout`).set("Cookie", who.cookies)
    const capture = (paymentIntentId: string, who: Diner = ada, cart = cartId) =>
        request(app).post(`/carts/tables/${tableId}/${cart}/captureStripeCheckout`).set("Cookie", who.cookies).send({ paymentIntentId })
    // Ada's card entered and authorised: the intent awaits capture.
    const authorised = async (who: Diner = ada) => {
        const res = await create(who)
        if (res.status !== 200) throw new Error(`createStripeCheckout answered ${res.status}: ${res.body.message}`)
        const pi = res.body.paymentIntentId as string
        fakeStripe.authorise(pi)
        return pi
    }
    const record = (pi: string) => StripeCheckoutModel.findById(pi).lean()
    const cart = () => CartModel.findById(cartId)
    // The table as a diner sees it (a 404 with notices once no cart is open).
    const view = (who: Diner = ada) => request(app).get(`/carts/tables/${tableId}`).set("Cookie", who.cookies)
    const messages = async (who: Diner = ada) => ((await view(who)).body.notices as { message: string }[]).map((n) => n.message)

    return { owner, shopId, tableId, latte, ada, cartId, select: select_, create, capture, authorised, record, cart, view, messages }
}

export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000)

// A record's fields written as they'd be later (timestamps included).
export const setRecord = (pi: string, fields: Record<string, unknown>) =>
    StripeCheckoutModel.collection.updateOne({ _id: pi as never }, { $set: fields })

// Claimed by someone else: a holder with a live lease, or (`expired`) one that
// stopped without finishing.
export const heldElsewhere = (pi: string, { expired = false, state = "finishing" } = {}) =>
    setRecord(pi, { state, token: "someone-else", leaseUntil: new Date(Date.now() + (expired ? -1000 : 60_000)) })
