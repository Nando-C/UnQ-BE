import { JsonSchema, Parameter, Response, error, json, ref } from "./helpers"
import { CHECKOUT_STATES } from "../services/carts/stripeCheckout"
import { PAYMENT_PROVIDERS, PAYMENT_STATUSES, REFUND_REASONS, REFUND_STATUSES } from "../services/carts/model"
import { DONE_AS, PAYBACK_KINDS } from "../services/payments/payback"
import { MAX_REPORT_DAYS } from "../services/shops/schemas"
import { GROUP_BY } from "../lib/days"

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

const userFields = {
    _id: objectId,
    name: { type: "string" },
    surname: { type: "string", description: "Absent on some Google accounts" },
    email: { type: "string", format: "email", description: "Stored trimmed and lowercased" },
    avatar: { type: "string", format: "uri" },
    role: { type: "string", enum: ["customer", "shopMg", "admin"], description: "shopMg (shop manager) can create shops; admin can do everything on every shop and manage accounts. Never from the account's own request (register, profile edit): an administrator gives them (POST /users, PUT /users/{userId}/role); the first administrator is set in the database" },
    googleId: { type: "string" },
    hasPassword: { type: "boolean", description: "Whether the account can sign in with a password; a Google-only account can't" },
    createdBy: { ...objectId, description: "Who made the account when it wasn't the person (an administrator, or a shop's owner adding staff); absent on a self-registered one" },
    ...timestamps,
}
const User = object(userFields, ["_id", "name", "email", "role", "hasPassword", "createdAt", "updatedAt"],
"An account, as users/model.ts's toJSON sends it: never the password hash or the sessions")

// GET /users: an account with the shops it is a member of.
const ListedUser = object({
    ...userFields,
    shops: array(object({ _id: objectId, name: { type: "string" }, role: { type: "string", enum: ["owner", "manager"] } }, ["_id", "name", "role"])),
}, ["_id", "name", "email", "role", "hasPassword", "createdAt", "updatedAt", "shops"], "An account and the shops it is a member of, with its role on each")

const AccountPage = object({
    users: array(ref("ListedUser")),
    total: { type: "integer", description: "Accounts matching, over every page" },
    page: { type: "integer" },
    limit: { type: "integer" },
}, ["users", "total", "page", "limit"], "A page of accounts, newest first")

// GET /shops/{shopId}/staff: a member joined to their account.
const StaffMember = object({
    userId: nullable(objectId),
    name: nullable({ type: "string" }),
    surname: { type: "string" },
    email: nullable({ type: "string", format: "email" }),
    avatar: { type: "string", format: "uri" },
    role: { type: "string", enum: ["owner", "manager"] },
    since: { ...date, description: "When they joined" },
    addedBy: { ...objectId, description: "Who added them; absent for a shop's first owner and for the members of a shop from before membership" },
}, ["userId", "name", "email", "role", "since"], "A member of a shop, with their account's name, email and avatar (null once the account is gone)")

const StaffAdded = object({
    member: ref("StaffMember"),
    created: { type: "boolean", description: "true: the account was created for them (201); false: an existing account was attached (200)" },
}, ["member", "created"])

const Session = object({
    _id: objectId,
    createdAt: { ...date, description: "When the device signed in" },
    lastUsedAt: { ...date, description: "When it last refreshed its tokens (or signed in)" },
    userAgent: { type: "string", description: "The browser's User-Agent at sign-in, up to 200 characters; absent when it sent none" },
    current: { type: "boolean", description: "Whether this is the caller's own session" },
}, ["_id", "createdAt", "lastUsedAt", "current"], "A device signed in on the account (auth/controllers.ts listSessions); never the refresh token or its id")

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

// One member of a shop, as stored (the staff route joins them to names).
const Member = object({
    userId: objectId,
    role: { type: "string", enum: ["owner", "manager"], description: "owner: one per shop, the only member who deletes it; manager: runs it" },
    since: { ...date, description: "When they joined (the shop's creation for a shop from before membership)" },
    addedBy: { ...objectId, description: "Who added them; absent for a shop's first owner and for the members of a shop from before membership" },
}, ["userId", "role", "since"])

const shopFields = {
    _id: objectId,
    name: { type: "string" },
    cover: { type: "string", format: "uri", description: "A placeholder until one is uploaded" },
    bio: { type: "string" },
    open_times: { type: "string" },
    phone: { type: "string", description: "As typed" },
    web_URL: { type: "string" },
    timeZone: { type: "string", description: "The zone the shop's days are counted in (an IANA name); Europe/London unless set" },
    shopMg: { ...array(objectId), description: "Every member's user id, the owner's included: who may run the shop" },
    ownerId: { ...objectId, description: "The owner's user id. Absent on a shop from before membership that no member has opened yet; set the first time one does" },
    tables: array(ref("Table")),
    ...timestamps,
}
const shopRequired = ["_id", "name", "cover", "timeZone", "shopMg", "tables", "menu", "createdAt", "updatedAt"]
// The members' roles and dates are the staff's to see, not the public's.
const members = { members: { ...array(ref("Member")), description: "One per id in shopMg; [] on a shop from before membership that no member has opened yet" } }

const Shop = object({ ...shopFields, menu: array(ref("MenuItem")) }, shopRequired,
    "A shop as everyone sees it: menu items populated, deleted tables left out")

const ShopRecord = object({ ...shopFields, ...members, menu: { ...array(objectId), description: "The menu items' ids" }, deletedTables: array(ref("DeletedTable")) },
    [...shopRequired, "deletedTables"], "A shop as stored: menu items by id, deleted tables and members included (the answer to creating or editing one)")

const ManagerShop = object({ ...shopFields, ...members, menu: array(ref("MenuItem")), deletedTables: array(ref("ManagerDeletedTable")) },
    [...shopRequired, "deletedTables"], "A shop for its staff: menu items populated, deleted tables with what still needs them, members")

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

// The sales report (shops/controllers/salesControllers.ts).
const day: JsonSchema = { type: "string", format: "date", description: "A day in the shop's time zone, YYYY-MM-DD" }
const count = (description: string): JsonSchema => ({ type: "integer", description })
const byProvider = (each: JsonSchema): JsonSchema => object(Object.fromEntries(PAYMENT_PROVIDERS.map((p) => [p, each])), [...PAYMENT_PROVIDERS], "By payment provider")
const SalesRange = object({
    from: day, to: day,
    timeZone: { type: "string", description: "The shop's zone, which every day and hour here is in" },
    by: { ...enumOf(GROUP_BY), description: "The bucket the series is grouped in; weeks start on Monday" },
    days: count("Days in the range, both ends counted"),
}, ["from", "to", "timeZone", "by", "days"], "The range reported, as counted")
const SalesTotals = object({
    gross: pounds("Completed payments made in the range"),
    refunds: pounds("Completed refunds made in the range, whenever their sale was"),
    net: pounds("gross − refunds"),
    orders: count("Completed payments"),
    pendingOrders: count("Payments in the range still awaiting their provider: not counted anywhere else"),
    visits: count("Distinct carts paid"),
    diners: count("Distinct payers"),
    returningDiners: count("Of the diners, those who had paid at this shop before the range began"),
    units: count("Units sold, less those refunded"),
    byProvider: byProvider(object({ gross: pounds("Completed payments"), orders: count("Completed payments") }, ["gross", "orders"])),
}, ["gross", "refunds", "net", "orders", "pendingOrders", "visits", "diners", "returningDiners", "units", "byProvider"])
const SalesBucket = object({
    bucket: { ...day, description: "The bucket's first day (its Monday or its 1st); the first may start before `from`" },
    gross: pounds("Completed payments"), refunds: pounds("Completed refunds made in the bucket"), net: pounds("gross − refunds"),
    orders: count("Completed payments"), visits: count("Distinct carts"), diners: count("Distinct payers"),
    newDiners: count("Diners whose first payment at this shop, ever, fell in this bucket"),
    units: count("Units sold, less those refunded"),
    byCategory: object({ food: pounds("Lines sold"), drinks: pounds("Lines sold"), other: pounds("Lines whose category wasn't known") }, ["food", "drinks", "other"], "Gross by the lines' category, as sold"),
    byProvider: byProvider(pounds("Completed payments")),
}, ["bucket", "gross", "refunds", "net", "orders", "visits", "diners", "newDiners", "units", "byCategory", "byProvider"],
"One bucket of the series; every bucket in the range is present, zero where nothing was sold")
const SalesCell = object({
    dow: { type: "integer", minimum: 1, maximum: 7, description: "ISO weekday: 1 Monday … 7 Sunday" },
    hour: { type: "integer", minimum: 0, maximum: 23 },
    orders: count("Completed payments"), gross: pounds("Completed payments"),
}, ["dow", "hour", "orders", "gross"], "Sales at this weekday and hour (only cells with a sale)")
const SalesItem = object({
    menuId: objectId,
    name: { type: "string", description: "As diners saw it last in the range (a renamed dish keeps one row)" },
    category: nullable({ type: "string" }),
    unitPrice: pounds("The price diners paid last in the range"),
    units: count("Sold, less refunded"), refundedUnits: count("Refunded, whenever the refund was made"),
    revenue: pounds("units × the price each was sold at"),
}, ["menuId", "name", "category", "unitPrice", "units", "refundedUnits", "revenue"], "A menu item's sales, by revenue")
const SalesRefunds = object({
    count: count("Completed refunds made in the range"),
    byReason: array(object({ reason: nullable(enumOf(REFUND_REASONS)), count: count("Refunds"), amount: pounds("Refunded") }, ["reason", "count", "amount"], "By the reason given; null when none was")),
    byHour: array(object({ hour: { type: "integer", minimum: 0, maximum: 23 }, count: count("Refunds"), amount: pounds("Refunded") }, ["hour", "count", "amount"], "By the hour the refund was made")),
}, ["count", "byReason", "byHour"])
const SalesTable = object({
    tableId: { type: "string", description: "The table, current or deleted" },
    name: nullable({ type: "string", description: "As the orders recorded it" }),
    orders: count("Completed payments"), visits: count("Distinct carts"),
    gross: pounds("Completed payments"), refunds: pounds("Completed refunds made in the range on this table's orders"), net: pounds("gross − refunds"),
}, ["tableId", "name", "orders", "visits", "gross", "refunds", "net"], "A table's sales, by net")
const SalesReport = object({
    range: ref("SalesRange"),
    totals: ref("SalesTotals"),
    series: array(ref("SalesBucket")),
    heatmap: array(ref("SalesCell")),
    items: array(ref("SalesItem")),
    refunds: ref("SalesRefunds"),
    tables: array(ref("SalesTable")),
    previous: object({ range: ref("SalesRange"), totals: ref("SalesTotals"), series: array(ref("SalesBucket")) }, ["range", "totals", "series"],
        "With `compare=previous`: the range of the same length ending the day before `from`, counted and bucketed the same way"),
}, ["range", "totals", "series", "heatmap", "items", "refunds", "tables"],
`A shop's sales over a range of its days (at most ${MAX_REPORT_DAYS}), counted as a till would: gross is completed payments by the day paid, refunds count on the day they were made, net is the difference. Money in pounds, summed in pence`)

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
    User, ListedUser, AccountPage, StaffMember, StaffAdded, Session, Table, DeletedTable, ManagerDeletedTable, MenuItem, Member, Shop, ShopRecord, ManagerShop, ShopSummary, ShopPage,
    MenuRef, CartItem, Split, ManagerSplit, Notice, ManagerNotice, PaymentLine, Payment, Refund, LogEntry,
    Cart, ManagerCart, CartNotFound, TableStatus, Payback, TableCarts, CloseResult, RefundResult, PaymentCheckResult, PaybackResult,
    PayPalOrder, StripeIntent, Received, Health, Error: ErrorBody,
    SalesReport, SalesRange, SalesTotals, SalesBucket, SalesCell, SalesItem, SalesRefunds, SalesTable,
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
    sessionId: pathParam("sessionId", "The session (a user's sessions[]._id, from GET /auth/sessions)"),
    userId: pathParam("userId", "The account"),
}

// What express-rate-limit's standard headers say on a 429.
const rateLimitHeaders = {
    "RateLimit": { description: "The limit's current state (IETF draft 8)", schema: { type: "string" } },
    "RateLimit-Policy": { description: "The limit's policy (IETF draft 8)", schema: { type: "string" } },
}

// Answers several routes give the same way.
export const responses: Record<string, Response> = {
    ValidationFailed: error('"Validation failed", with `details`: the body (or query) failed its schema'),
    Unauthorized: error('No access-token cookie ("Please provide credentials in cookies!"), or an expired or invalid one ("Invalid token"): refresh the token (POST /auth/refreshToken) and retry'),
    UserGone: error('"User not found!": the token\'s account no longer exists'),
    NotThisShopsManager: error('"Shop Manager Only!": the account isn\'t a member of this shop (nor an administrator)'),
    NotThisShopsOwner: error('"Only the owner can do this": the account isn\'t this shop\'s owner (nor an administrator)'),
    AdministratorOnly: error('"Administrator only": the account isn\'t an administrator'),
    TooManyAdded: {
        ...error('"Too many people added in an hour — wait a while and try again": more than PEOPLE_ADDED_PER_HOUR (default 20) accounts created or attached by this account in an hour'),
        headers: rateLimitHeaders,
    },
    ShopNotFound: error('"Shop Not Found!"'),
    TooManyEdits: {
        ...error('"Too many changes to your order — wait a minute and try again": more than CART_EDITS_PER_MINUTE (default 120) changes by this account in a minute'),
        headers: rateLimitHeaders,
    },
    TooManyWrongPasswords: error('"Too many wrong passwords for this account — try again in 15 minutes": more than PASSWORD_FAILS_PER_ACCOUNT (default 10) wrong passwords for the account in 15 minutes, wherever they were tried'),
    ServerError: error('"Generic Server Error", unless the message was written for the user (then it is shown as is)'),
    DinerCart: json("The cart as the caller sees it", ref("Cart")),
    ManagerCart: json("The cart as the manager sees it", ref("ManagerCart")),
}
