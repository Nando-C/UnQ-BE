import { randomUUID } from "crypto"
import { TController } from "src/typings/controllers"
import { IUserDocument } from "src/typings/users"
import createError from "http-errors"
import CartModel from "./model"
import { shopIdOfCart } from "../shops/model"
import StripeCheckoutModel from "./stripeCheckout"
import { CART_MENUS, checkoutCheck, forDiner } from "./controllers"
import { cartGone, finishStripeIntent, stillConfirmingAnswer, takeBackAnswer } from "./stripeFinish"
import { cancelIntent, createIntent } from "../../lib/stripe"
import { toPence } from "../../lib/money"

// Card checkout, beside PayPal's (controllers.ts), in two calls around Stripe's
// Payment Element:
//   1. createStripeCheckout: a PaymentIntent for the exact amount due, which
//      the diner's card only authorises (manual capture).
//   2. (the diner confirms it in the Payment Element, with their bank's check)
//   3. captureStripeCheckout: checks again, then captures or releases the hold
//      (stripeFinish.ts, shared with the sweep and the webhook).
// Amounts always come from DB prices, never from the client.

const COULD_NOT_START = "Could not start a card payment"

// Step 1, with createCheckoutOrder's checks. The intent's record is written
// right after Stripe creates it, so no intent exists the sweep can't see: if
// it can't be, the intent is cancelled. An intent nobody confirms holds
// nothing, and the sweep cancels it an hour after it was created. Answers the
// intent's amount (pence) too: the frontend confirms only the amount it showed.
// The record keeps the table's shop (a pay-back may need it after the cart is
// gone): an older cart that doesn't record it finds it by its table, and gets
// it; a table no shop has any more is refused before anything is created.
export const createStripeCheckout: TController = async ( req, res, next ) => {
    try {
        const user = req.user as IUserDocument
        const { cartId, tableId } = req.params as { cartId: string; tableId: string }

        const check = await checkoutCheck(cartId, tableId, user._id)
        if (!check.ok) return next(createError(check.status, check.message))
        const amount = toPence(check.total)
        const shopId = await shopIdOfCart(check.cart)
        if (!shopId) return next(createError(404, "This table is no longer at a shop"))
        if (!check.cart.shopId) await CartModel.updateOne({ _id: cartId, shopId: { $exists: false } }, { $set: { shopId } })

        let intent
        try {
            intent = await createIntent(amount, { cartId, tableId, userId: String(user._id) })
        } catch (error) {
            console.error("Stripe intent not created", { cartId, error })
            return next(createError(502, COULD_NOT_START, { expose: true }))
        }
        try {
            await StripeCheckoutModel.create({ _id: intent.id, cartId, tableId, shopId, userId: user._id, amount })
        } catch (error) {
            console.error("Stripe intent's record not written: cancelling it", { paymentIntentId: intent.id, error })
            await cancelIntent(intent.id).catch((cancelError) =>
                console.error("…and it couldn't be cancelled (it holds nothing until the diner confirms it)", { paymentIntentId: intent.id, error: cancelError }))
            return next(createError(502, COULD_NOT_START, { expose: true }))
        }

        res.send({ clientSecret: intent.client_secret, paymentIntentId: intent.id, amount })
    } catch (error) {
        next(createError(500, error as Error))
    }
}

// Step 3: 200 with the cart, 202 for a pending payment (its units held), 502
// with `reason: "STILL_CONFIRMING"` when it can't tell yet, else an error as
// captureCheckout's. Answers correctly when the webhook or the sweep already
// finished the payment and closed the cart. Not rate limited (see rateLimits.ts).
export const captureStripeCheckout: TController = async ( req, res, next ) => {
    const { paymentIntentId } = req.body as { paymentIntentId: string }
    // This request's mark on the outcome it answers (see Caller).
    const stamp = randomUUID()
    // Whether the diner is still there to read the answer (else they get a
    // notice of the outcome instead): the response closed before it was sent,
    // or the socket's gone. Never the request's own `close` event or
    // `req.destroyed`, which fire once the body is read (Node 16+).
    let gone = false
    res.on("close", () => {
        if (res.writableFinished) return
        gone = true
        // Gone before the reply was sent: the answer wasn't read, so the
        // diner gets the notice instead.
        takeBackAnswer(paymentIntentId, stamp)
            .catch((error) => console.error("A card payment's notice couldn't be brought back", { paymentIntentId, error }))
    })
    const connected = () => !gone && !req.socket.destroyed
    const user = req.user as IUserDocument
    const { cartId, tableId } = req.params as { cartId: string; tableId: string }

    // Something failed after the outcome may have been settled: never "it
    // failed". This request's answer, if it marked one, is taken back and the
    // caller's own record (never another's) marked for a notice, and the
    // diner is told it's still being confirmed.
    const stillConfirmingInstead = async (why: string, error: unknown) => {
        console.error(why, { paymentIntentId, error })
        await Promise.all([
            takeBackAnswer(paymentIntentId, stamp),
            StripeCheckoutModel.updateOne({ _id: paymentIntentId, cartId, tableId, userId: user._id }, { $set: { confirmed: true } }),
        ]).catch((markError) => console.error("…and it couldn't be marked for a notice", { paymentIntentId, error: markError }))
        const { status, message, reason } = stillConfirmingAnswer(paymentIntentId)
        next(createError(status, message, { expose: true, reason }))
    }

    try {
        const outcome = await finishStripeIntent(paymentIntentId, { caller: { cartId, tableId, userId: String(user._id), connected, stamp } })
        if (outcome.kind !== "answer") throw new Error(`Unexpected outcome for the diner's capture: ${outcome.kind}`)
        if (outcome.status < 300) {
            try {
                const cart = await CartModel.findById(outcome.cartId).populate(CART_MENUS)
                // Deleted since it was recorded (with its table or shop).
                if (!cart) {
                    const { status, message, reason } = cartGone(outcome.status === 202)
                    return next(createError(status, message, { reason }))
                }
                return res.status(outcome.status).send(await forDiner(cart, req))
            } catch (error) {
                // Recorded, but the reply can't be built.
                return await stillConfirmingInstead("Card payment recorded, but its reply failed", error)
            }
        }
        next(createError(outcome.status, outcome.message ?? "", {
            ...(outcome.expose ? { expose: true } : {}),
            ...(outcome.reason ? { reason: outcome.reason } : {}),
        }))
    } catch (error) {
        // The record stays as it was (claimed until its lease runs out): the
        // webhook or the sweep finishes it, and the diner hears the outcome.
        await stillConfirmingInstead("Finishing a card payment failed", error)
    }
}
