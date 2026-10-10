import { JsonSchema, Parameter, Response, error, json, ref } from "./helpers"
import { CHECKOUT_STATES } from "../services/carts/stripeCheckout"
import { PAYMENT_PROVIDERS, PAYMENT_STATUSES, REFUND_REASONS, REFUND_STATUSES } from "../services/carts/model"
import { DONE_AS, PAYBACK_KINDS } from "../services/payments/payback"

// Response schemas, written from the Mongoose models (services/*/model.ts),
// their toJSON methods, and the controllers' select/populate/strip logic. The
// request bodies come from the zod schemas (helpers.fromZod) instead.

const objectId: JsonSchema = { type: "string", pattern: "^[0-9a-f]{24}$", description: "A MongoDB ObjectId" }
const date: JsonSchema = { type: "string", format: "date-time" }
const pounds = (description: string): JsonSchema => ({ type: "number", description: `${description}, in pounds (GBP), to the penny` })
const enumOf = (values: readonly string[]): JsonSchema => ({ type: "string", enum: [...values] })
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] })
const array = (items: JsonSchema): JsonSchema => ({ type: "array", items })

const object = (properties: Record<string, JsonSchema>, required: string[], description?: string): JsonSchema =>
    ({ type: "object", ...(description ? { description } : {}), properties, required })

// Mongoose's timestamps (every collection but Order and Payback).
const timestamps = { createdAt: date, updatedAt: date }

// A person named for staff: populated `{ _id, name }`, or null once the
// account is gone.
const userName = nullable(object({ _id: objectId, name: { type: "string" } }, ["_id", "name"], "A user by first name"))

const User = object({
    _id: objectId,
    name: { type: "string" },
    surname: { type: "string", description: "Absent on some Google accounts" },
    email: { type: "string", format: "email", description: "Stored trimmed and lowercased" },
    avatar: { type: "string", format: "uri" },
    role: { type: "string", enum: ["customer", "shopMg"], description: "shopMg (shop manager) is set in the database, never through the API" },
    googleId: { type: "string" },
    hasPassword: { type: "boolean", description: "Whether the account can sign in with a password; a Google-only account can't" },
    ...timestamps,
}, ["_id", "name", "email", "role", "hasPassword", "createdAt", "updatedAt"],
"An account, as users/model.ts's toJSON sends it: never the password hash or the refresh token")

const Table = object({ _id: objectId, name: { type: "string" }, Qr_Url: { type: "string", format: "uri", description: "The table's page in the front end, printed as its QR code" } },
    ["_id", "name", "Qr_Url"], "A table of a shop")

const DeletedTable = object({ _id: objectId, name: { type: "string" }, deletedAt: date }, ["_id", "name", "deletedAt"],
    "A table the manager deleted: it takes no orders, and its recent carts stay reachable")

const ManagerDeletedTable = object({
    _id: objectId,
    name: { type: "string" },
    deletedAt: date,
    needsAttention: { type: "boolean", const: true, description: "Present when the table still has an open cart, money a provider hasn't confirmed, or a diner to pay back" },
    recentCartsUntil: { ...date, description: "Present while a closed cart of the table is still on its sheet (24 hours after it last changed)" },
}, ["_id", "name", "deletedAt"])

const MenuItem = object({
    _id: objectId,
    name: { type: "string" },
    image: { type: "string", format: "uri", description: "A placeholder until one is uploaded" },
    short_description: { type: "string" },
    description: { type: "string" },
    price: pounds("The price"),
    available: { type: "boolean", description: "false: sold out (or deleted). It can't be added, selected or paid for" },
    category: { type: "string", enum: ["food", "drinks"] },
    deletedFrom: { ...objectId, description: "The shop it was deleted from: it left the menu but is kept for the carts that hold it" },
    ...timestamps,
}, ["_id", "name", "image", "short_description", "price", "available", "category", "createdAt", "updatedAt"])

const shopFields = {
    _id: objectId,
    name: { type: "string" },
    cover: { type: "string", format: "uri", description: "A placeholder until one is uploaded" },
    bio: { type: "string" },
    open_times: { type: "string" },
    phone: { type: "string", description: "As typed" },
    web_URL: { type: "string" },
    shopMg: { ...array(objectId), description: "The managers' user ids" },
    tables: array(ref("Table")),
    ...timestamps,
}
const shopRequired = ["_id", "name", "cover", "shopMg", "tables", "menu", "createdAt", "updatedAt"]

const Shop = object({ ...shopFields, menu: array(ref("MenuItem")) }, shopRequired,
    "A shop as everyone sees it: menu items populated, deleted tables left out")

const ShopRecord = object({ ...shopFields, menu: { ...array(objectId), description: "The menu items' ids" }, deletedTables: array(ref("DeletedTable")) },
    [...shopRequired, "deletedTables"], "A shop as stored: menu items by id, deleted tables included (the answer to creating or editing one)")

const ManagerShop = object({ ...shopFields, menu: array(ref("MenuItem")), deletedTables: array(ref("ManagerDeletedTable")) },
    [...shopRequired, "deletedTables"], "A shop for its manager: menu items populated, deleted tables with what still needs them")

const ShopSummary = object({ _id: objectId, name: { type: "string" }, bio: { type: "string" }, cover: { type: "string", format: "uri" } },
    ["_id", "name", "cover"], "A shop on the home page's list")

const ShopPage = object({ shops: array(ref("ShopSummary")), next: nullable({ ...objectId, description: "The cursor for the next page; null on the last" }) },
    ["shops", "next"])

// Menu fields every cart response populates (carts/controllers.ts MENU_FIELDS);
// an item deleted before items were kept is a stand-in with fewer fields.
const MenuRef = object({
    _id: objectId,
    name: { type: "string", description: '"No longer on the menu" for an item that is gone' },
    short_description: { type: "string" },
    image: { type: "string", format: "uri" },
    price: pounds("The current price"),
    available: { type: "boolean" },
    category: { type: "string", enum: ["food", "drinks"] },
}, ["_id", "name", "price", "available"], "A menu item as a cart names it")

const CartItem = object({
    _id: objectId,
    menuId: ref("MenuRef"),
    qty: { type: "integer", description: "Units ordered" },
    qtyPayed: { type: "integer", description: "Units paid for (the spelling is part of the API)" },
}, ["_id", "menuId", "qty", "qtyPayed"], "A line of the table's order")

const splitFields = {
    _id: objectId,
    menuId: ref("MenuRef"),
    qty: { type: "integer" },
    splitStatus: { type: "string", enum: ["open", "closed"], description: "open: selected to pay for; closed: paid" },
    unitPrice: pounds("What each unit was charged at (set when paid)"),
    paidAt: date,
    claimedAt: { ...date, description: "When first selected" },
}
const splitRequired = ["_id", "userId", "menuId", "qty", "splitStatus"]
const Split = object({ userId: objectId, ...splitFields }, splitRequired, "A diner's share of a line: who pays for how many units")
const ManagerSplit = object({ userId: userName, ...splitFields }, splitRequired, "A split with the diner named")

const Notice = object({ _id: { type: "string", description: "An ObjectId, or a longer id for a card payment's outcome" }, at: date, message: { type: "string" } },
    ["_id", "at", "message"], "A note to the table's diners about a change to their cart")

const ManagerNotice = object({ _id: objectId, at: date, forUserId: { ...objectId, description: "Present when the note is for one diner alone" }, message: { type: "string" } },
    ["_id", "at", "message"])

const PaymentLine = object({
    menuId: objectId,
    name: { type: "string" },
    qty: { type: "integer" },
    unitPrice: pounds("The price charged per unit"),
    refundedQty: { type: "integer", description: "Units of this line refunded since" },
    category: { type: "string", description: "The item's category when paid (absent on older payments)" },
}, ["menuId", "name", "qty", "unitPrice", "refundedQty"])

const Payment = object({
    _id: objectId,
    provider: enumOf(PAYMENT_PROVIDERS),
    status: { ...enumOf(PAYMENT_STATUSES), description: "pending: taken but not confirmed by the provider; its units are held, the cart stays open, and it can't be refunded until a manager checks it" },
    providerCheckoutId: { type: "string", description: "PayPal's order id, or Stripe's PaymentIntent id" },
    providerPaymentId: { type: "string", description: "PayPal's capture id, or Stripe's charge id: what a refund is made against. Missing only if the provider gave none" },
    currency: { type: "string", description: "GBP" },
    userId: userName,
    paidAt: date,
    amount: pounds("What was taken"),
    lines: array(ref("PaymentLine")),
}, ["_id", "provider", "status", "providerCheckoutId", "currency", "userId", "paidAt", "amount", "lines"],
"One settled checkout, at the prices charged. Manager-only")

const Refund = object({
    _id: objectId,
    paymentId: objectId,
    lines: array(object({ menuId: objectId, name: { type: "string" }, qty: { type: "integer" } }, ["menuId", "name", "qty"])),
    amount: pounds("Refunded"),
    currency: { type: "string" },
    status: { ...enumOf(REFUND_STATUSES), description: "pending: the provider was asked and hasn't clearly answered (retry it); completed; failed (nothing moved)" },
    providerRefundId: { type: "string" },
    failureReason: { type: "string" },
    byUserId: objectId,
    at: date,
    reason: enumOf(REFUND_REASONS),
    reasonNote: { type: "string", description: 'Only with reason "other"' },
}, ["_id", "paymentId", "lines", "amount", "currency", "status", "byUserId", "at"], "A manager's refund of some units of a payment. Manager-only")

const LogEntry = object({
    at: date,
    byUserId: { ...userName, description: "The manager; absent when the server itself wrote the line (the Stripe sweep or webhook)" },
    action: { type: "string", description: "releaseSelection, removeItem, close, mergeInto, refund, checkPayment, stripeRefundFailed, paybackDone" },
    details: { type: "string" },
}, ["at", "action"])

const cartFields = {
    _id: objectId,
    userId: { ...objectId, description: "The diner who started the cart" },
    shopId: { ...objectId, description: "Absent on carts from before carts recorded their shop" },
    tableId: objectId,
    status: { type: "string", enum: ["open", "splitted", "closed"], description: '"splitted" is a legacy value nothing sets any more' },
    items: array(ref("CartItem")),
    ...timestamps,
}
const cartRequired = ["_id", "userId", "tableId", "status", "items", "split", "notices", "createdAt", "updatedAt"]

const Cart = object({
    ...cartFields,
    split: array(ref("Split")),
    notices: { ...array(ref("Notice")), description: "Recent (2 hours), newest first, at most 5: the table's, plus the caller's own when signed in" },
}, cartRequired, "A table's cart as a diner sees it (carts/model.ts dinerView): no payment or refund records, no manager log, no provider ids")

const ManagerCart = object({
    ...cartFields,
    paypalOrderId: { type: "string", description: "Legacy: the one PayPal order of a cart settled before multi-payer support" },
    paypalOrderIds: { ...array({ type: "string" }), description: "Every PayPal order that settled part of this cart" },
    stripePaymentIntentIds: { ...array({ type: "string" }), description: "Every Stripe PaymentIntent that settled part of this cart" },
    split: array(ref("ManagerSplit")),
    payments: array(ref("Payment")),
    refunds: array(ref("Refund")),
    notices: array(ref("ManagerNotice")),
    managerLog: array(ref("LogEntry")),
}, [...cartRequired, "payments", "refunds", "managerLog"], "A cart as its shop's manager sees it: everything, diners by first name")

const CartNotFound = object({
    message: { type: "string", const: "Cart Not Found!" },
    notices: { ...array(ref("Notice")), description: "For a signed-in diner who took part in a cart closed lately: its recent notices (a refund, the close); empty for anyone else" },
}, ["message", "notices"])

const TableStatus = object({
    tableId: objectId,
    name: { type: "string" },
    state: { type: "string", enum: ["free", "ordering", "waitingToPay", "partlyPaid"], description: "free: nothing ordered; ordering: items, none paid or selected; waitingToPay: someone has a selection open; partlyPaid: some units paid, none selected now" },
    owed: pounds("Unpaid units at current prices (sold-out items not counted)"),
    paid: pounds("Paid units at the prices paid"),
    heldSince: { ...date, description: "The oldest open selection's claim time, when there is one" },
    attention: array({ type: "string", enum: ["soldOut", "duplicateCarts", "staleSelection", "paymentPending", "payBack"] }),
}, ["tableId", "name", "state", "owed", "paid", "attention"])

const Payback = object({
    _id: objectId,
    shopId: objectId,
    tableId: objectId,
    cartId: objectId,
    kind: { ...enumOf(PAYBACK_KINDS), description: "refundRefused: a card payment that couldn't be recorded and whose refund Stripe won't make; refundFailed: a manager's card refund Stripe accepted then failed" },
    userId: { ...userName, description: "The diner owed" },
    amount: pounds("Owed"),
    currency: { type: "string" },
    paymentIntentId: { type: "string", description: "Stripe's, to find it in the dashboard" },
    refundId: { ...objectId, description: "The cart refund (refundFailed)" },
    paymentAmount: pounds("The whole payment's amount (refundFailed)"),
    disputed: { type: "boolean", description: "The diner disputes the payment with their bank, which returns it: staff don't" },
    owed: { type: "boolean", const: true, description: "Present until marked done" },
    at: date,
    doneAt: date,
    doneByUserId: userName,
    doneAs: enumOf(DONE_AS),
    recorded: { type: "boolean", const: true, description: "Present on an owed refundRefused pay-back whose payment a cart now shows as paid" },
}, ["_id", "shopId", "tableId", "cartId", "kind", "userId", "amount", "currency", "at"],
"Money staff must give a diner back another way, because Stripe won't. Manager-only")

const TableCarts = object({
    open: { ...array(ref("ManagerCart")), description: "The table's open cart (more than one only for legacy duplicates), newest first" },
    recentlyClosed: { ...array(ref("ManagerCart")), description: "Closed in the last 24 hours, or older but still awaiting a provider" },
    paybacks: { ...array(ref("Payback")), description: "Owed, and done in the last 30 days, newest first" },
}, ["open", "recentlyClosed", "paybacks"])

const Dropped = array(object({ menuId: objectId, name: { type: "string" }, qty: { type: "integer" } }, ["menuId", "name", "qty"], "Unpaid units the close dropped"))

const CloseResult = {
    oneOf: [
        object({ deleted: { type: "boolean", const: true }, dropped: Dropped }, ["deleted", "dropped"], "Nothing was ever paid on the cart: it was deleted"),
        object({ deleted: { type: "boolean", const: false }, dropped: Dropped, cart: ref("ManagerCart") }, ["deleted", "dropped", "cart"], "The cart is closed; its paid units stay as the record"),
    ],
}

const RefundResult = object({ refund: ref("Refund"), cart: ref("ManagerCart") }, ["refund", "cart"])
const PaymentCheckResult = object({ payment: ref("Payment"), cart: ref("ManagerCart") }, ["payment", "cart"])
const PaybackResult = object({ payback: ref("Payback") }, ["payback"])

const PayPalOrder = object({ paypalOrderId: { type: "string", description: "The order to approve in PayPal's popup, then capture" } }, ["paypalOrderId"])

const StripeIntent = object({
    clientSecret: { type: "string", description: "For Stripe's Payment Element" },
    paymentIntentId: { type: "string", pattern: "^pi_" },
    amount: { type: "integer", description: "In pence: the front end confirms only the amount it showed" },
}, ["clientSecret", "paymentIntentId", "amount"])

const Received = object({ received: { type: "boolean", const: true } }, ["received"])

const Health = object({
    status: { type: "string", const: "ok" },
    version: { type: "string", description: "The API's version (package.json)" },
    uptime: { type: "number", description: "Seconds since the process started" },
}, ["status", "version", "uptime"])

const ErrorBody = object({
    message: { type: "string" },
    details: {
        ...array(object({ path: { type: "string", description: 'The field, dotted ("lines.0.qty")' }, message: { type: "string" } }, ["path", "message"])),
        description: 'With "Validation failed": one entry per problem',
    },
    reason: { type: "string", description: "A machine-readable why, where a client acts on it: superseded, CART_GONE, CART_GONE_PENDING, STILL_CONFIRMING" },
}, ["message"], "Every error answer (errorMiddlewares.ts). A 5xx says only \"Generic Server Error\" unless its message was written for the user")

export const schemas: Record<string, JsonSchema> = {
    User, Table, DeletedTable, ManagerDeletedTable, MenuItem, Shop, ShopRecord, ManagerShop, ShopSummary, ShopPage,
    MenuRef, CartItem, Split, ManagerSplit, Notice, ManagerNotice, PaymentLine, Payment, Refund, LogEntry,
    Cart, ManagerCart, CartNotFound, TableStatus, Payback, TableCarts, CloseResult, RefundResult, PaymentCheckResult, PaybackResult,
    PayPalOrder, StripeIntent, Received, Health, Error: ErrorBody,
    StripeCheckoutState: { ...enumOf(CHECKOUT_STATES), description: "A card payment record's state (carts/stripeCheckout.ts); not served by any route, listed for the notices' wording" },
}

const pathParam = (name: string, description: string): Parameter => ({ name, in: "path", required: true, description, schema: objectId })

export const parameters: Record<string, Parameter> = {
    shopId: pathParam("shopId", "The shop"),
    tableId: pathParam("tableId", "The table (a shop's tables[]._id)"),
    cartId: pathParam("cartId", "The cart"),
    itemId: pathParam("itemId", "The menu item"),
    paymentId: pathParam("paymentId", "The payment (a cart's payments[]._id)"),
    refundId: pathParam("refundId", "The refund (a cart's refunds[]._id)"),
    paybackId: pathParam("paybackId", "The pay-back"),
}

// Answers several routes give the same way.
export const responses: Record<string, Response> = {
    ValidationFailed: error('"Validation failed", with `details`: the body (or query) failed its schema'),
    Unauthorized: error('No access-token cookie ("Please provide credentials in cookies!"), or an expired or invalid one ("Invalid token"): refresh the token (POST /auth/refreshToken) and retry'),
    UserGone: error('"User not found!": the token\'s account no longer exists'),
    ManagerOnly: error('"Shop Manager Only!!": the account isn\'t a shop manager'),
    NotThisShopsManager: error('"Shop Manager Only!": the account doesn\'t manage this shop'),
    ShopNotFound: error('"Shop Not Found!"'),
    TooManyEdits: {
        ...error('"Too many changes to your order — wait a minute and try again": more than CART_EDITS_PER_MINUTE (default 120) changes by this account in a minute'),
        headers: {
            "RateLimit": { description: "The limit's current state (IETF draft 8)", schema: { type: "string" } },
            "RateLimit-Policy": { description: "The limit's policy (IETF draft 8)", schema: { type: "string" } },
        },
    },
    TooManyWrongPasswords: error('"Too many wrong passwords for this account — try again in 15 minutes": more than PASSWORD_FAILS_PER_ACCOUNT (default 10) wrong passwords for the account in 15 minutes, wherever they were tried'),
    ServerError: error('"Generic Server Error", unless the message was written for the user (then it is shown as is)'),
    DinerCart: json("The cart as the caller sees it", ref("Cart")),
    ManagerCart: json("The cart as the manager sees it", ref("ManagerCart")),
}
