import { Paths, PUBLIC, empty, error, fromZod, json, jsonBody, param, ref, sharedResponse } from "../helpers"
import { cartItemSchema, cartItemWithQtySchema, checkOutSplitSchema, stripeCaptureSchema } from "../../services/carts/schemas"

// services/carts/routes.ts: controllers.ts (ordering, selecting, PayPal
// checkout) and stripeControllers.ts (card checkout).

const order = ["Carts: ordering"]
const split = ["Carts: selecting what to pay"]
const pay = ["Carts: checkout"]

const signedIn = { 401: sharedResponse("Unauthorized") }
// JWTAuthMiddleware then cartEditLimit, before validate (malformed requests count).
const editing = { ...signedIn, 429: sharedResponse("TooManyEdits") }

const tableParams = [param("shopId"), param("tableId")]
const splitParams = [param("shopId"), param("tableId"), param("cartId")]
const checkoutParams = [param("tableId"), param("cartId")]

const soldOut = '"This item is sold out"'
// checkoutCheck (controllers.ts): the checks before any money moves.
const checkout404 = '"Cart Not Found!": no open cart with this id at this table; "No open split items to pay!"; "User not found!"'
const checkout409 = '"A split item is no longer in the cart"; "Not enough unpaid units left to settle this checkout"; "Some items you selected are sold out — remove them to pay for the rest"'

export const cartPaths: Paths = {
    "/carts/{shopId}/tables/{tableId}/addItem": {
        post: {
            operationId: "addItem", tags: order,
            summary: "Add units of an item to the table's order",
            description: "A table has one shared open cart: whoever orders first creates it (the caller becomes its `userId`), everyone else adds to it. The item must be on this shop's menu and not sold out, and the table one of the shop's. Racing another diner's first order is retried onto the cart that won.",
            parameters: tableParams,
            requestBody: jsonBody(fromZod(cartItemWithQtySchema, { menuId: "The menu item", qty: "Units to add" })),
            responses: {
                200: sharedResponse("DinerCart"),
                400: sharedResponse("ValidationFailed"),
                ...editing,
                404: error('"Menu Item Not Found!": no such item, or not on this shop\'s menu; "Table Not Found!": not one of the shop\'s tables; "User not found!"'),
                409: error(`${soldOut}; "The cart changed, please retry"`),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/carts/{shopId}/tables/{tableId}/removeItem": {
        post: {
            operationId: "decreaseItem", tags: order,
            summary: "Take units off an item's line (the −)",
            description: "Drops the line at 0. Never into units already paid for or held in someone's open selection. A cart emptied this way is deleted (204) unless it holds payment, refund or manager records; one left with everything paid closes.",
            parameters: tableParams,
            requestBody: jsonBody(fromZod(cartItemWithQtySchema, { menuId: "The menu item", qty: "Units to take off" })),
            responses: {
                200: sharedResponse("DinerCart"),
                204: empty("The cart was emptied and deleted"),
                400: sharedResponse("ValidationFailed"),
                ...editing,
                404: error('"Item Not Found in Cart!": the table has no open cart with that item; "User not found!"'),
                409: error('"Those units are already paid for or selected for payment"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/carts/{shopId}/tables/{tableId}/deleteItem": {
        post: {
            operationId: "deleteCartItem", tags: order,
            summary: "Remove an item's unpaid units (the bin)",
            description: "What stays: the paid units (the record of what was paid) and the units other diners have selected to pay for, with their selections; a line with neither is dropped. The caller's own selection goes with the units. A sold-out or deleted item goes whoever selected it (nobody can pay for it): this is how it leaves a cart. Version-checked, so a payment settling at the same moment conflicts instead of being overwritten. A cart emptied with nothing to keep is deleted (204).",
            parameters: tableParams,
            requestBody: jsonBody(fromZod(cartItemSchema)),
            responses: {
                200: sharedResponse("DinerCart"),
                204: empty("The cart was emptied and deleted"),
                400: sharedResponse("ValidationFailed"),
                ...editing,
                404: error('"Item Not Found in Cart!": the table has no open cart with that item; "User not found!"'),
                409: error('"Someone at the table is paying for those": nothing the caller may remove; "The cart changed, please retry"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/carts/{shopId}/tables/{tableId}/{cartId}/addSplitItem": {
        post: {
            operationId: "addSplitItem", tags: split,
            summary: "Select more units of an item to pay for",
            description: "Grows the caller's open selection of the item, or starts one. The units every diner's open selections already hold, plus the request, plus the paid units must fit in the line: checked and claimed in one atomic update, so two diners racing for the last unit can't both get it. No new claims on a sold-out item.",
            parameters: splitParams,
            requestBody: jsonBody(fromZod(cartItemWithQtySchema, { menuId: "The menu item", qty: "Units to select" })),
            responses: {
                200: sharedResponse("DinerCart"),
                400: sharedResponse("ValidationFailed"),
                ...editing,
                404: error('"Cart Not Found!": no open cart with this id at this table; "Item Not Found in Cart!"; "User not found!"'),
                409: error(`${soldOut}; "Not enough units left to split"`),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/carts/{shopId}/tables/{tableId}/{cartId}/decreaseSplitItem": {
        post: {
            operationId: "decreaseSplitItem", tags: split,
            summary: "Select one unit fewer",
            description: "Takes one unit off the caller's open selection of the item, dropping the selection at 0.",
            parameters: splitParams,
            requestBody: jsonBody(fromZod(cartItemSchema)),
            responses: {
                200: sharedResponse("DinerCart"),
                400: sharedResponse("ValidationFailed"),
                ...editing,
                404: error('"Item Not Found!": the caller has no open selection of that item on this cart; "User not found!"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/carts/{shopId}/tables/{tableId}/{cartId}/removeSplitItem": {
        post: {
            operationId: "removeSplitItem", tags: split,
            summary: "Un-select an item",
            description: "Drops the caller's open selection of the item.",
            parameters: splitParams,
            requestBody: jsonBody(fromZod(cartItemSchema)),
            responses: {
                200: sharedResponse("DinerCart"),
                400: sharedResponse("ValidationFailed"),
                ...editing,
                404: error('"Item Not Found!": the caller has no open selection of that item on this cart; "User not found!"'),
                500: sharedResponse("ServerError"),
            },
        },
    },

    // PayPal: two calls around the popup.
    "/carts/tables/{tableId}/{cartId}/createCheckoutOrder": {
        post: {
            operationId: "createCheckoutOrder", tags: pay,
            summary: "PayPal, step 1: an order for the amount due",
            description: "Creates the PayPal order for exactly what the caller's open selections cost at database prices, bound to this cart and payer. Nothing is charged or stored. The checks run before PayPal is called, so a doomed checkout never mints an order. Not rate limited.",
            parameters: checkoutParams,
            responses: {
                200: json("The order to approve in the popup", ref("PayPalOrder")),
                ...signedIn,
                404: error(checkout404),
                409: error(checkout409),
                500: sharedResponse("ServerError"),
                502: error('"Could not create PayPal order"'),
            },
        },
    },
    "/carts/tables/{tableId}/{cartId}/captureCheckout": {
        post: {
            operationId: "captureCheckout", tags: pay,
            summary: "PayPal, step 2: capture the approved order",
            description: "The money-moving call. Refuses a replayed order id, runs step 1's checks again, confirms with PayPal that the order is approved, was minted for this cart and payer and matches the amount still due, and only then captures. The settlement is saved under optimistic concurrency; if it can't be (a concurrent payer took the units) the buyer is refunded automatically and told so. A capture PayPal holds for review is recorded as a pending payment (202): its units are held, the cart stays open, and a manager checks it later. Not rate limited.",
            parameters: checkoutParams,
            requestBody: jsonBody(fromZod(checkOutSplitSchema, { paypalOrderId: "The order from step 1, approved in the popup" })),
            responses: {
                200: sharedResponse("DinerCart"),
                202: json("Paid, but PayPal holds the capture for review: the units are held as a pending payment", ref("Cart")),
                400: sharedResponse("ValidationFailed"),
                ...signedIn,
                402: error('"This PayPal order has already been used"; "Could not verify PayPal payment"; "PayPal order is not approved for capture"; "PayPal order was not created for this checkout"; "PayPal capture failed"; "PayPal capture did not complete"'),
                404: error(checkout404),
                409: error(`${checkout409}; "Your selection changed since the order was created, please retry" (nothing charged); "The table's cart changed while you were paying — your payment was refunded"; "Your payment could not be recorded — your payment was refunded"`),
                500: error('"Payment captured but could not be settled or refunded — please contact staff (order …)"; or "Generic Server Error"'),
                502: error('"We couldn\'t confirm your payment with PayPal — please contact staff before paying again (order …)": PayPal\'s answer didn\'t say whether the buyer was charged'),
            },
        },
    },

    // Stripe: two calls around the Payment Element.
    "/carts/tables/{tableId}/{cartId}/createStripeCheckout": {
        post: {
            operationId: "createStripeCheckout", tags: pay,
            summary: "Card, step 1: a PaymentIntent for the amount due",
            description: "Creates a Stripe PaymentIntent (manual capture: the card is only authorised) for exactly what the caller's open selections cost, and a record of it the server's sweep can see. Rate limited like an edit: each call makes an intent. An intent nobody confirms holds nothing and is cancelled after an hour.",
            parameters: checkoutParams,
            responses: {
                200: json("The intent for the Payment Element", ref("StripeIntent")),
                ...editing,
                404: error(`${checkout404}; "This table is no longer at a shop"`),
                409: error(checkout409),
                500: sharedResponse("ServerError"),
                502: error('"Could not start a card payment"'),
            },
        },
    },
    "/carts/tables/{tableId}/{cartId}/captureStripeCheckout": {
        post: {
            operationId: "captureStripeCheckout", tags: pay,
            summary: "Card, step 2: capture the authorised payment",
            description: "After the diner confirms the intent. Checks again, then captures or releases the hold; shared with the webhook and the sweep, so the answer is right when one of them already finished the payment. A payment still processing is recorded pending (202). When the outcome can't be told yet the answer is 502 with `reason: \"STILL_CONFIRMING\"`: don't pay again; the cart updates once it's known, and the diner gets a notice. Not rate limited: a refused capture would leave an authorised payment unfinished.",
            parameters: checkoutParams,
            requestBody: jsonBody(fromZod(stripeCaptureSchema, { paymentIntentId: "The intent from step 1" })),
            responses: {
                200: sharedResponse("DinerCart"),
                202: json("Captured, but the payment is still processing: the units are held as a pending payment", ref("Cart")),
                400: sharedResponse("ValidationFailed"),
                ...signedIn,
                402: error('"This payment was not created for this checkout"; "This payment didn\'t go through: nothing was taken"; "Payment not completed — nothing was charged"; "Card payment capture failed — nothing was charged"'),
                404: error('"Cart Not Found!"; "No open split items to pay!"; "User not found!"; or, money moved and the cart deleted since: "Your card payment went through, but this table\'s cart is no longer here" (`reason: "CART_GONE"`), "Your card payment is being confirmed, but this table\'s cart is no longer here" (`reason: "CART_GONE_PENDING"`)'),
                409: error(`${checkout409}; "Your selection changed since the order was created, please retry"; "The table's cart changed while you were paying — your payment was refunded"; "Your payment could not be recorded — your payment was refunded"`),
                500: error('"Payment captured but could not be recorded or refunded — please contact staff (payment …)"; "Payment captured but couldn\'t be refunded to your card while you dispute it: your bank returns it (payment …)"'),
                502: error('`reason: "STILL_CONFIRMING"`: "We\'re still confirming your payment. Your cart will update once it\'s confirmed, and you\'ll get a note if it doesn\'t go through — until then, please don\'t pay for these items again (payment …)"'),
            },
        },
    },

    // Reading carts.
    "/carts/tables/{tableId}": {
        get: {
            operationId: "getTableCart", tags: order, security: PUBLIC,
            summary: "The table's open cart",
            description: "Public: anyone at the table (no sign-in) sees the table's order, with its table-wide notices. A signed-in diner also gets the notices meant for them, their card payments' outcomes among them. With no open cart, the 404 carries the notices a signed-in diner who took part in a cart closed lately would otherwise miss. A cookie that is present but expired or invalid is a 401, so the front end refreshes it rather than show a guest view.",
            parameters: [param("tableId")],
            responses: {
                200: sharedResponse("DinerCart"),
                401: error('"Invalid token": the access-token cookie is present but expired or invalid'),
                404: json('No open cart at this table ("Cart Not Found!"), with the caller\'s recent notices', ref("CartNotFound")),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/carts": {
        get: {
            operationId: "getMyCarts", tags: order,
            summary: "The open cart the caller started",
            description: "One cart, not a list, despite the name: the open cart whose `userId` is the caller.",
            responses: {
                200: sharedResponse("DinerCart"),
                ...signedIn,
                404: error('"Carts Not Found!": the caller started no open cart; "User not found!"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/carts/{cartId}": {
        get: {
            operationId: "getSingleCart", tags: order,
            summary: "A cart the caller took part in",
            description: "Open or closed: the caller started it or has a selection on it.",
            parameters: [param("cartId")],
            responses: {
                200: sharedResponse("DinerCart"),
                ...signedIn,
                404: error('"Cart Not Found!": no such cart, or not one the caller took part in; "User not found!"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
}
