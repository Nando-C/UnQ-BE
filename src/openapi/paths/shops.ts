import { Paths, PUBLIC, abilityOf, empty, error, fromZod, imageBody, json, jsonBody, param, queryParams, ref, sharedResponse, uploadErrors } from "../helpers"
import { MAX_REPORT_DAYS, addStaffSchema, browseShopsSchema, createShopSchema, createTableSchema, editShopSchema, editTableSchema, handOverSchema, salesExportSchema, salesQuerySchema, setMemberRoleSchema } from "../../services/shops/schemas"
import { cartItemSchema, refundSchema, releaseSelectionSchema } from "../../services/carts/schemas"
import { paybackDoneSchema } from "../../services/payments/paybackControllers"

// services/shops/routes.ts: shops/controllers/*.ts, carts/managerControllers.ts,
// payments/paybackControllers.ts.

const shops = ["Shops"]
const tables = ["Tables"]
const manage = ["Manager: tables"]
const money = ["Manager: refunds and payments"]
const sales = ["Manager: sales"]
const staff = ["Staff"]

const signedIn = { 401: sharedResponse("Unauthorized") }
// JWTAuthMiddleware then isShopManager (a member of THIS shop, or an administrator; 404 if there's no such shop),
// then, where the operation says so (x-ability), allows: the member's role holds the ability.
const thisManager = { ...signedIn, 403: sharedResponse("NotThisShopsManager") }
// JWTAuthMiddleware then isShopOwner (THIS shop's owner, or an administrator; 404 if there's no such shop).
const thisOwner = { ...signedIn, 403: sharedResponse("NotThisShopsOwner") }
const cartChanged = '"The cart changed, please retry": another write landed first (a payment settling, another manager)'
const cartParams = [param("shopId"), param("tableId"), param("cartId")]
const managedCart404 = error('"Cart Not Found!": no open cart with this id at this table of this shop; "Shop Not Found!"')

const rangeDescribed = {
    from: "The first day, YYYY-MM-DD, in the shop's time zone",
    to: `The last day, included; with \`from\`, a range of at most ${MAX_REPORT_DAYS} days (so at most ${MAX_REPORT_DAYS - 1} days after it)`,
}

export const shopPaths: Paths = {
    "/shops": {
        post: {
            operationId: "createShop", tags: shops,
            summary: "Create a shop",
            description: "The caller becomes its owner (`ownerId`, the first of its `members`). An administrator is never a member, so one names the owner instead (`ownerId`, any account but another administrator's); from anyone else the field is refused.",
            requestBody: jsonBody(fromZod(createShopSchema, { phone: "As typed, up to 30 characters: digits, spaces, dashes, brackets, +", timeZone: "An IANA time zone name (Europe/London, America/New_York): the zone the shop's days are counted in; Europe/London unless set", ownerId: "Administrators only: the account that owns the new shop" })),
            responses: {
                200: json("The new shop", ref("ShopRecord")),
                400: error('"Validation failed" (details); "Name the shop\'s owner (ownerId): an administrator isn\'t a member"'),
                401: sharedResponse("Unauthorized"),
                403: error('"Shop Manager Only!!": the account can\'t create shops; "Only an administrator names an owner": `ownerId` from a shop manager'),
                404: error('"User not found!": the token\'s account no longer exists; "Owner not found": no account has the `ownerId`'),
                409: error('"An administrator can\'t be a member of a shop": the `ownerId` is an administrator\'s'),
                500: sharedResponse("ServerError"),
            },
        },
        get: {
            operationId: "getAllShops", tags: shops, security: PUBLIC,
            summary: "Every shop",
            description: "Menus populated, deleted tables left out. The home page uses `GET /shops/browse` instead.",
            responses: {
                200: json("All shops", { type: "array", items: ref("Shop") }),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/me": {
        get: {
            operationId: "getMyShops", tags: shops,
            summary: "The caller's shops",
            description: "The shops the caller is a member of, whatever their account role: `[]` for an account on none, every shop for an administrator. Menus populated. Each deleted table says whether something there still needs the staff (`needsAttention`) and until when its closed carts stay on its sheet (`recentCartsUntil`). A shop from before membership gets its `ownerId` and `members` here, from its `shopMg`.",
            responses: {
                200: json("The shops the caller is a member of", { type: "array", items: ref("ManagerShop") }),
                ...signedIn,
                404: sharedResponse("UserGone"),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/browse": {
        get: {
            operationId: "browseShops", tags: shops, security: PUBLIC,
            summary: "A page of shops, searched on the server",
            description: "Oldest first, by id. With `q`, only shops whose name or bio holds it, or whose menu has an item named with it (case aside). `next` is the cursor for the page after, null on the last. An empty parameter counts as absent; a repeated one fails.",
            parameters: queryParams(browseShopsSchema, {
                q: "Text to search for (up to 100 characters); empty or absent lists every shop",
                cursor: "The `next` of the previous page",
                limit: "Shops per page, 1 to 50 (default 20)",
            }),
            responses: {
                200: json("A page", ref("ShopPage")),
                400: sharedResponse("ValidationFailed"),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}": {
        get: {
            operationId: "getSingleShop", tags: shops, security: PUBLIC,
            summary: "One shop",
            description: "Menu populated, deleted tables left out.",
            parameters: [param("shopId")],
            responses: {
                200: json("The shop", ref("Shop")),
                404: error('"Shop Not Found!"'),
                500: sharedResponse("ServerError"),
            },
        },
        put: {
            operationId: "editMyShop", tags: shops, ...abilityOf("shop.edit"),
            summary: "Edit a shop the caller is a member of",
            description: "The owner's and managers' (`x-roles`), whatever their account role, or an administrator's. Every field optional; only the ones sent change. An empty `phone` clears it.",
            parameters: [param("shopId")],
            requestBody: jsonBody(fromZod(editShopSchema, { phone: "As typed, up to 30 characters: digits, spaces, dashes, brackets, +", timeZone: "An IANA time zone name (Europe/London, America/New_York): the zone the shop's days are counted in" })),
            responses: {
                200: json("The shop as it is now (menu by id)", ref("ShopRecord")),
                400: sharedResponse("ValidationFailed"),
                ...thisManager,
                404: error('"Shop Not Found!"; "User not found!"'),
                500: sharedResponse("ServerError"),
            },
        },
        delete: {
            operationId: "deleteMyShop", tags: shops, ...abilityOf("shop.own"),
            summary: "Delete a shop and everything in it",
            description: "The owner's alone (or an administrator's). Takes its menu items (deleted ones too), its carts (payment records included) and its pay-backs; the orders remain as the sales record, written first (nothing is deleted if they can't be). Refused while money is still moving: an open cart, a payment or refund a provider hasn't confirmed, a card payment still being finished, a diner to pay back, or a payment that can still be refunded from a table's sheet (a paid cart closed or changed in the last 24 hours).",
            parameters: [param("shopId")],
            responses: {
                204: empty("Deleted"),
                ...thisOwner,
                404: error('"Shop Not Found!"; "User not found!"'),
                409: error('"A table in this shop has an open cart — close it first"; "A payment or refund at table … is still awaiting PayPal|Stripe — check it there first"; "A payment at table … can still be refunded from its sheet: the shop can be deleted once no paid cart has changed for a day"; or a card-payment reason (carts/stripeDeletion.ts)'),
                500: error('"The shop\'s sales records couldn\'t be saved, so nothing was deleted. Try again shortly."; or "Generic Server Error"'),
            },
        },
    },
    "/shops/{shopId}/staff": {
        get: {
            operationId: "listStaff", tags: staff, ...abilityOf("staff.read"),
            summary: "The shop's members",
            description: "Each joined to their account (name, email, avatar), the owner first. Every member of the shop, or an administrator.",
            parameters: [param("shopId")],
            responses: {
                200: json("The members", { type: "object", properties: { members: { type: "array", items: ref("StaffMember") } }, required: ["members"] }),
                ...thisManager,
                404: error('"Shop Not Found!"; "User not found!"'),
                500: sharedResponse("ServerError"),
            },
        },
        post: {
            operationId: "addStaff", tags: staff,
            summary: "Add someone to the shop",
            description: "By their email. An address with an account attaches that account, name and password untouched (200); one without gets an account created from `name`, `surname` and `password`, which the caller tells them (201; account role `customer`, `createdBy` the caller). The owner (or an administrator) gives any role but owner; a manager gives `till`, `floor` or `kitchen`. One update puts them in both membership lists, so two adds of one person land once. Counts towards the caller's people-added limit, created or attached.",
            parameters: [param("shopId")],
            requestBody: jsonBody(fromZod(addStaffSchema, { email: "Trimmed and lowercased", role: "The membership role they get: manager (the owner gives it), or till, floor or kitchen", name: "For a new account", surname: "For a new account", password: "For a new account: at least 8 characters, its first password" })),
            responses: {
                200: json("An existing account, attached", ref("StaffAdded")),
                201: json("An account created for them, attached", ref("StaffAdded")),
                400: error('"Validation failed" (details; for a new account, name, surname and password are "Required for a new account"); "That is your own address"'),
                401: sharedResponse("Unauthorized"),
                403: error('"Shop Manager Only!": not a member of this shop; "Only the owner adds managers": a manager asked for one; "Your role on this shop doesn\'t allow this": the caller is till, floor or kitchen'),
                404: error('"Shop Not Found!"; "User not found!"'),
                409: error('"Already a member"; "An administrator can\'t be a member of a shop"; "The shop\'s staff changed, please retry": the shop lost its owner or the account went in the same instant'),
                429: sharedResponse("TooManyAdded"),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}/staff/{userId}": {
        put: {
            operationId: "setMemberRole", tags: staff,
            summary: "Change a member's role",
            description: "To any role but owner. The caller must be allowed to handle both the role the member has and the new one: the owner (or an administrator) changes anyone's but the owner's; a manager moves `till`, `floor` and `kitchen` among themselves and never makes or unmakes a manager; nobody changes their own. The owner's role changes by handing the shop over. One update, matched on the member still holding the role read.",
            parameters: [param("shopId"), param("userId")],
            requestBody: jsonBody(fromZod(setMemberRoleSchema, { role: "The new role" })),
            responses: {
                200: json("The members, as GET /shops/{shopId}/staff lists them", { type: "object", properties: { members: { type: "array", items: ref("StaffMember") } }, required: ["members"] }),
                400: sharedResponse("ValidationFailed"),
                401: sharedResponse("Unauthorized"),
                403: error('"Shop Manager Only!": not a member of this shop; "The owner\'s role changes by handing the shop over"; "Only the owner changes a manager\'s role": a manager, to or from manager; "Your role on this shop doesn\'t allow this": the caller is till, floor or kitchen'),
                404: error('"Shop Not Found!"; "Not a member of this shop"; "User not found!"'),
                409: error('"Already that role"; "The shop\'s staff changed, please retry": a hand-over, a removal or another change landed in the same instant'),
                500: sharedResponse("ServerError"),
            },
        },
        delete: {
            operationId: "removeStaff", tags: staff,
            summary: "Remove a member",
            description: "The owner (or an administrator) removes anyone but the owner; a manager only `till`, `floor` and `kitchen`; any member themselves (leaving). The owner is never removed: the shop is handed over first. The account stays.",
            parameters: [param("shopId"), param("userId")],
            responses: {
                204: empty("Removed"),
                401: sharedResponse("Unauthorized"),
                403: error('"Shop Manager Only!": not a member of this shop; "The owner can\'t be removed"; "Only the owner removes a manager": a manager asked; "Your role on this shop doesn\'t allow this": the caller is till, floor or kitchen'),
                404: error('"Shop Not Found!"; "Not a member of this shop"; "User not found!"'),
                409: error('"The shop\'s staff changed, please retry": a hand-over landed in the same instant'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}/owner": {
        put: {
            operationId: "handOver", tags: staff, ...abilityOf("shop.own"),
            summary: "Make another member the owner",
            description: "The owner (or an administrator) names a member, who becomes the owner; the previous owner becomes a manager. One update, matched on the current owner.",
            parameters: [param("shopId")],
            requestBody: jsonBody(fromZod(handOverSchema, { userId: "A member of the shop" })),
            responses: {
                200: json("The members, as GET /shops/{shopId}/staff lists them", { type: "object", properties: { members: { type: "array", items: ref("StaffMember") } }, required: ["members"] }),
                400: sharedResponse("ValidationFailed"),
                ...thisOwner,
                404: error('"Shop Not Found!"; "Not a member of this shop"; "User not found!"'),
                409: error('"Already the owner"; "The shop\'s staff changed, please retry": another hand-over, a removal or a deletion landed in the same instant'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}/cover": {
        put: {
            operationId: "editMyShopCover", tags: shops, ...abilityOf("shop.edit"),
            summary: "Upload a shop's cover image",
            description: "The membership and role checks run before the upload, so a refused request never reaches Cloudinary. The replaced image is deleted there if this app uploaded it.",
            parameters: [param("shopId")],
            requestBody: imageBody("cover"),
            responses: {
                200: json("The shop with its new cover (menu by id)", ref("ShopRecord")),
                400: error('"Only JPEG, PNG, WebP, GIF, AVIF or HEIC images can be uploaded"; "No image was sent (field \\"cover\\")"'),
                413: uploadErrors[413],
                ...thisManager,
                404: sharedResponse("ShopNotFound"),
                500: sharedResponse("ServerError"),
            },
        },
    },

    // Tables.
    "/shops/{shopId}/tables": {
        post: {
            operationId: "createTable", tags: tables, ...abilityOf("tables.edit"),
            summary: "Add a table",
            description: "Names are unique within the shop (checked in the same update, so two requests at once can't both pass). The table's QR URL is its page in the front end.",
            parameters: [param("shopId")],
            requestBody: jsonBody(fromZod(createTableSchema)),
            responses: {
                200: json("The new table", ref("Table")),
                400: error('"Validation failed" (details); "Table name: \'…\' already exist!"'),
                ...thisManager,
                404: sharedResponse("ShopNotFound"),
                500: sharedResponse("ServerError"),
            },
        },
        get: {
            operationId: "getTableList", tags: tables,
            summary: "The shop's tables",
            description: "Any signed-in user. Deleted tables are not listed.",
            parameters: [param("shopId")],
            responses: {
                200: json("The tables", { type: "array", items: ref("Table") }),
                ...signedIn,
                404: error('"Shop Not Found!"; "User not found!"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}/tables/{tableId}": {
        get: {
            operationId: "getSingleTable", tags: tables, security: PUBLIC,
            summary: "One table",
            description: "What the table's QR code opens. A deleted table, or another shop's, is not found.",
            parameters: [param("shopId"), param("tableId")],
            responses: {
                200: json("The table", ref("Table")),
                404: error('"Table Not Found!": no such shop, or no such table in it'),
                500: sharedResponse("ServerError"),
            },
        },
        put: {
            operationId: "editTable", tags: tables, ...abilityOf("tables.edit"),
            summary: "Rename a table",
            description: "The new name must be unique within the shop. Answers the shop's whole table list, not the one table.",
            parameters: [param("shopId"), param("tableId")],
            requestBody: jsonBody(fromZod(editTableSchema)),
            responses: {
                200: json("All the shop's tables, with the rename", { type: "array", items: ref("Table") }),
                400: error('"Validation failed" (details); "Table name: \'…\' already exist!"'),
                ...thisManager,
                404: error('"Table Not Found!"; "Shop Not Found!"'),
                500: sharedResponse("ServerError"),
            },
        },
        delete: {
            operationId: "deleteTable", tags: tables, ...abilityOf("tables.edit"),
            summary: "Delete a table",
            description: "Moved to the shop's deleted tables rather than dropped: it takes no orders and diners don't see it, but the manager can still open its recent carts to refund them. Refused while it has an open cart (close it first) or a payment or refund awaiting its provider. Deleting it twice is a 204 both times.",
            parameters: [param("shopId"), param("tableId")],
            responses: {
                204: empty("Deleted (or already deleted)"),
                ...thisManager,
                404: error('"Table Not Found!"; "Shop Not Found!"'),
                409: error('"This table has an open cart — close it first"; "A payment or refund at this table is still awaiting PayPal|Stripe — check it first"; "The table changed, please try again"'),
                500: sharedResponse("ServerError"),
            },
        },
    },

    // The sales report.
    "/shops/{shopId}/sales": {
        get: {
            operationId: "getSales", tags: sales, ...abilityOf("sales.read"),
            summary: "The shop's sales over a range of days",
            description: `Everything the sales page shows, in one answer: totals, a zero-filled series by day, week or month, sales by weekday and hour, items by revenue, refunds by reason and hour, and the tables. Counted as a till would, in the shop's time zone: gross is completed payments by the day paid; refunds count on the day they were made (completed only), whenever their sale was; net is the difference. Visits are distinct carts, diners distinct payers, and a returning diner had paid at this shop before the range began. Items are net of refunded units under the name and price diners saw last. With \`compare=previous\`, the range of the same length ending the day before is reported too. At most ${MAX_REPORT_DAYS} days.`,
            parameters: [param("shopId"), ...queryParams(salesQuerySchema, {
                ...rangeDescribed,
                by: "How the series is bucketed; unless given, by day up to 92 days and by week beyond. Weeks start on Monday",
                compare: "`previous` adds the range of the same length ending the day before `from`",
            })],
            responses: {
                200: json("The report", ref("SalesReport")),
                400: sharedResponse("ValidationFailed"),
                ...thisManager,
                404: sharedResponse("ShopNotFound"),
                500: sharedResponse("ServerError"),
            },
        },
    },

    "/shops/{shopId}/sales/export": {
        get: {
            operationId: "exportSales", tags: sales, ...abilityOf("sales.read"),
            summary: "One of the report's tables as a CSV file",
            description: "Counted as the report counts, in the shop's time zone, as a download. `orders`: a row per payment made in the range, completed or still pending (paid at, table, provider, status, amount, refunded to date, net, items as \"2× Latte, 1× Sea Bass\"); `items`: a row per menu item sold, by revenue; `days`: a row per day of the range, zero-filled, with the category and provider splits. No diner is named or identified in any of them. UTF-8 with a byte-order mark, CRLF line ends; a cell that would start with `=`, `+`, `-`, `@` or a tab gets a leading apostrophe so a spreadsheet can't run it as a formula.",
            parameters: [param("shopId"), ...queryParams(salesExportSchema, {
                ...rangeDescribed,
                table: "Which table",
            })],
            responses: {
                200: {
                    description: "The file",
                    content: { "text/csv": { schema: { type: "string" } } },
                    headers: { "Content-Disposition": { description: "attachment; filename=<shop>-sales-<from>-<to>-<table>.csv (the shop's name as letters, digits and dashes)", schema: { type: "string" } } },
                },
                400: sharedResponse("ValidationFailed"),
                ...thisManager,
                404: sharedResponse("ShopNotFound"),
                500: sharedResponse("ServerError"),
            },
        },
    },

    // The manager's view of the tables' carts.
    "/shops/{shopId}/tables/status": {
        get: {
            operationId: "getTablesStatus", tags: manage, ...abilityOf("tables.read"),
            summary: "Every table's state at a glance",
            description: "One entry per current table, from its open cart(s): what's owed and paid, who's waiting, and what needs attention (a sold-out item ordered, two open carts, a selection held over 15 minutes, a payment the provider hasn't confirmed, a diner to pay back).",
            parameters: [param("shopId")],
            responses: {
                200: json("The tables", { type: "array", items: ref("TableStatus") }),
                ...thisManager,
                404: sharedResponse("ShopNotFound"),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}/tables/{tableId}/carts": {
        get: {
            operationId: "getTableCarts", tags: manage, ...abilityOf("tables.read"),
            summary: "A table's carts, with payments",
            description: "The open cart(s), those closed in the last 24 hours (or older but still awaiting a provider), and the table's pay-backs. Payment and refund records and the manager log included; diners by first name only. Works for a deleted table too.",
            parameters: [param("shopId"), param("tableId")],
            responses: {
                200: json("The table's sheet", ref("TableCarts")),
                ...thisManager,
                404: error('"Table Not Found!": not a current or deleted table of this shop; "Shop Not Found!"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}/tables/{tableId}/carts/{cartId}/releaseSelection": {
        post: {
            operationId: "releaseSelection", tags: manage, ...abilityOf("carts.fix"),
            summary: "Free units diners hold in open selections",
            description: "Everyone's (empty body), one diner's (`userId`), the selections of diners whose account no longer exists (`userId: null`), or one item's (`menuId`), so others can pay for them. Each diner affected gets a note; the manager log gets a line. No money moves.",
            parameters: cartParams,
            requestBody: jsonBody(fromZod(releaseSelectionSchema, { userId: "One diner's selections; null: those of diners whose account is gone; absent: everyone's", menuId: "One item's selections only" })),
            responses: {
                200: sharedResponse("ManagerCart"),
                400: sharedResponse("ValidationFailed"),
                ...thisManager,
                404: error('"Cart Not Found!"; "No selection to release"; "Shop Not Found!"'),
                409: error(cartChanged),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}/tables/{tableId}/carts/{cartId}/removeItem": {
        post: {
            operationId: "managerRemoveItem", tags: manage, ...abilityOf("carts.fix"),
            summary: "Take an item's unpaid units out of the cart",
            description: "All of them, diners' selections of it included (the diner's own bin leaves others' selections); paid units stay as the record. A cart left with nothing ordered and nothing paid closes, so the table is free again. The table's diners get a note.",
            parameters: cartParams,
            requestBody: jsonBody(fromZod(cartItemSchema)),
            responses: {
                200: sharedResponse("ManagerCart"),
                400: sharedResponse("ValidationFailed"),
                ...thisManager,
                404: error('"Cart Not Found!"; "Item Not Found in Cart!"; "Shop Not Found!"'),
                409: error(`"Nothing unpaid to remove"; ${cartChanged}`),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}/tables/{tableId}/carts/{cartId}/close": {
        post: {
            operationId: "closeCart", tags: manage, ...abilityOf("carts.fix"),
            summary: "Close the table's cart",
            description: "Unpaid units and open selections are dropped (the kitchen only acts on paid orders); paid units stay. A cart where nothing was ever paid is deleted instead. Refused while a payment on it awaits its provider.",
            parameters: cartParams,
            responses: {
                200: json("What happened: deleted, or closed with the cart", ref("CloseResult")),
                ...thisManager,
                404: managedCart404,
                409: error(`"A payment on this table is still awaiting PayPal|Stripe: check it first"; ${cartChanged}`),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}/tables/{tableId}/carts/{cartId}/mergeInto": {
        post: {
            operationId: "mergeInto", tags: manage, ...abilityOf("carts.fix"),
            summary: "Merge a duplicate open cart into the newest one",
            description: "For a table with more than one open cart (data from before the one-open-cart index). Moves this older cart's unpaid units and open selections into the newest cart, the one diners see; its paid units stay on it as the record and it closes (or is deleted if nothing on it was ever paid). Answers the newest cart.",
            parameters: cartParams,
            responses: {
                200: sharedResponse("ManagerCart"),
                ...thisManager,
                404: managedCart404,
                409: error(`"This table has only one open cart"; "Merge the older cart into the newest one"; "A payment on this table is still awaiting PayPal|Stripe: check it first"; ${cartChanged}`),
                500: sharedResponse("ServerError"),
            },
        },
    },

    // Money moves.
    "/shops/{shopId}/carts/{cartId}/refunds": {
        post: {
            operationId: "refundItems", tags: money, ...abilityOf("payments.manage"),
            summary: "Refund units of one payment",
            description: "At the prices that payment charged; the units leave the cart (cancelled, not made payable again). Open or closed carts of the shop. A `pending` refund record is saved first (so a double click can't refund twice), the provider is asked with the record's id as its idempotency key, then the record is completed or marked failed. If the provider's answer is unclear the record stays pending: retry it. The payer gets a note; a pay-back is opened if Stripe later fails the refund.",
            parameters: [param("shopId"), param("cartId")],
            requestBody: jsonBody(fromZod(refundSchema, {
                paymentId: "The cart's payments[]._id",
                lines: "Units to refund, each item once",
                reason: "Why, for the sales report",
                reasonNote: 'What happened, 1 to 200 characters: required with "other", refused otherwise',
            })),
            responses: {
                200: json("The completed refund and the cart", ref("RefundResult")),
                400: error('"Validation failed" (details, whose messages include "List each item once", "Say what happened" and "A note goes with the reason Other only"); "That item isn\'t in this payment"; "Only N× … of this payment can still be refunded"; "… from this payment has already been refunded"'),
                ...thisManager,
                404: error('"Cart Not Found!": not a cart of this shop; "Payment Not Found!"; "Shop Not Found!"'),
                409: error(`"PayPal|Stripe hasn't confirmed this payment yet: check it first"; "This payment didn't go through at PayPal|Stripe: nothing was taken"; "This payment can only be refunded from PayPal|Stripe" (no capture or charge id); ${cartChanged}`),
                500: error('"The refund went through at PayPal|Stripe but couldn\'t be recorded here. It shows as in progress: retry it to record it."; or "Generic Server Error"'),
                502: error('"PayPal|Stripe didn\'t confirm the refund (…). It shows as in progress: retry it, which checks with PayPal|Stripe first." (outcome unknown; the record stays pending); "…. Nothing was refunded." (refused; the record is marked failed)'),
            },
        },
    },
    "/shops/{shopId}/carts/{cartId}/refunds/{refundId}/retry": {
        post: {
            operationId: "retryRefund", tags: money, ...abilityOf("payments.manage"),
            summary: "Settle a refund left in progress",
            description: "Asks the provider whether it has the refund (by the record's id). If so, it's recorded as the provider says (completed, or failed); if not, it's sent again under the same id, which the provider can't apply twice.",
            parameters: [param("shopId"), param("cartId"), param("refundId")],
            responses: {
                200: json("The refund and the cart", ref("RefundResult")),
                ...thisManager,
                404: error('"Cart Not Found!"; "Refund Not Found!"; "Payment Not Found!"; "Shop Not Found!"'),
                409: error('"This refund isn\'t in progress any more"'),
                500: error('"The refund went through at PayPal|Stripe but couldn\'t be recorded here. …"; or "Generic Server Error"'),
                502: error('"Couldn\'t check with PayPal|Stripe (…). The refund is still in progress: try again shortly."; "PayPal|Stripe says this refund failed. Nothing was refunded."; or the messages of POST …/refunds'),
            },
        },
    },
    "/shops/{shopId}/carts/{cartId}/payments/{paymentId}/check": {
        post: {
            operationId: "checkPayment", tags: money, ...abilityOf("payments.manage"),
            summary: "Ask the provider about a pending payment",
            description: "For a payment the provider hadn't confirmed at checkout (`status: pending`). Confirmed: it becomes `completed`, and the cart closes if that was all it waited for. Failed: it becomes `failed`, its units are unpaid again and back in the payer's selection (the cart reopens if it had closed). Still pending: nothing changes. The payer is told either way.",
            parameters: [param("shopId"), param("cartId"), param("paymentId")],
            responses: {
                200: json("The payment as it is now, and the cart", ref("PaymentCheckResult")),
                ...thisManager,
                404: error('"Cart Not Found!"; "Payment Not Found!"; "Shop Not Found!"'),
                409: error(`"This payment isn't awaiting confirmation any more"; "PayPal|Stripe is still processing this payment. Check again later"; ${cartChanged}`),
                500: sharedResponse("ServerError"),
                502: error('"Couldn\'t check with PayPal|Stripe (…). Try again shortly."'),
            },
        },
    },
    "/shops/{shopId}/paybacks/{paybackId}/done": {
        post: {
            operationId: "markPaybackDone", tags: money, ...abilityOf("payments.manage"),
            summary: "Mark a pay-back done",
            description: "`as` must be what the sheet showed: `paidBack` (staff gave the diner the money another way), `handled` (a disputed payment: the bank returns it), or `checked` (a hand-over whose payment a cart now shows as paid). One already done answers as it was marked, whatever was asked. One that changed since the sheet showed it is refused, so what's stored is what the manager confirmed. The cart gets a log line without touching its `updatedAt`.",
            parameters: [param("shopId"), param("paybackId")],
            requestBody: jsonBody(fromZod(paybackDoneSchema, { as: "What the sheet showed for this pay-back" })),
            responses: {
                200: json("The pay-back as it is now", ref("PaybackResult")),
                400: sharedResponse("ValidationFailed"),
                ...thisManager,
                404: error('"Pay-back Not Found!": not this shop\'s, or gone with it; "Shop Not Found!"'),
                409: error('"This pay-back changed: here it is again"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
}
