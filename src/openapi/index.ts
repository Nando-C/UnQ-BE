import fs from "fs"
import path from "path"
import env from "../settings/env"
import { parameters, responses, schemas } from "./components"
import { Paths } from "./helpers"
import { authPaths } from "./paths/auth"
import { userPaths } from "./paths/users"
import { shopPaths } from "./paths/shops"
import { menuPaths } from "./paths/menus"
import { cartPaths } from "./paths/carts"
import { paymentPaths } from "./paths/payments"
import { systemPaths } from "./paths/system"

// The API's contract as an OpenAPI 3.1 document, built in code: request
// bodies from the zod schemas the routes validate with, responses written from
// the models and controllers (components.ts), one file per service under
// paths/. Served at GET /openapi.json and browsed at GET /docs (routes.ts).
// tests/openapi.test.ts checks it lists exactly the routes the server serves
// (server.ts routeList) and validates against the OpenAPI schema.

// The version is the package's: one number for the code and its contract.
export const version = (): string =>
    (JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8")) as { version: string }).version

const description = `The API behind UnQ, a food and drinks ordering app: diners at a venue scan their table's QR code, order from their phones, pick what each of them pays for, and pay by PayPal or card (Stripe); managers run their shops, menus and tables from the same app.

## Conventions

- **Sign-in** is two HttpOnly cookies, \`accessToken\` (15 minutes) and \`refreshToken\` (4 weeks), set by the auth routes. Each sign-in is a session of its own, so an account can be signed in on several devices (up to 10) and sign one out (\`DELETE /auth/sessions/{sessionId}\`). A 401 means refresh (\`POST /auth/refreshToken\`) and retry; a refresh that fails ends the session. Operations marked with the lock need the cookie; the rest are public, and some show more to a signed-in caller.
- **Roles.** Every account is a \`customer\`; a \`shopMg\` (shop manager) can create shops, and an \`admin\` can do everything on every shop. Never from the account's own request (register, profile edit): an administrator gives them (the Accounts operations), and the first administrator is set in the database. A shop's staff are its \`members\`, each with a role (\`owner\`, one per shop, or \`manager\`), added by the owner (the Staff operations); the owner, or an administrator, alone adds managers, removes other members and hands the shop over, and any member may leave; manager routes check that the caller is a member of the shop in the URL, or an administrator (403 otherwise).
- **Ids** are MongoDB ObjectIds (24 hex characters). A table's id is its \`_id\` in the shop's \`tables\`.
- **Money** is in pounds (GBP) to the penny everywhere a cart, a payment or a refund says an amount, and the \`price\` a manager sets is the same. The one exception is \`createStripeCheckout\`'s \`amount\`, in pence, as Stripe counts. The client never names an amount to pay: every total comes from database prices.
- **Errors** are \`{ message, details?, reason? }\`. \`400 Validation failed\` carries \`details\`, one \`{ path, message }\` per problem; a few errors carry a machine-readable \`reason\`. A 5xx says only "Generic Server Error" unless its message was written for the user.
- **Rate limits**, per account, not per IP: wrong passwords (10 in 15 minutes, wherever tried), a diner's cart changes (120 a minute, starting a card payment included; capturing a payment is never limited) and people added (20 an hour, an account created or attached by an administrator or a shop's staff). All configurable (\`PASSWORD_FAILS_PER_ACCOUNT\`, \`CART_EDITS_PER_MINUTE\`, \`PEOPLE_ADDED_PER_HOUR\`).
- **Soft deletes.** A deleted menu item stays, unavailable, for the carts that hold it; a deleted table stays under the shop's \`deletedTables\` so its carts and money stay reachable; a shop is deleted for good, with everything in it, once no money is moving.
- **Concurrency.** A cart is saved under optimistic concurrency: a write that meets a newer version retries or answers 409 "The cart changed, please retry".

## Checkout

A diner selects units to pay for (\`addSplitItem\`), then pays in two calls around the provider's UI: PayPal \`createCheckoutOrder\` → popup → \`captureCheckout\`; card \`createStripeCheckout\` → Payment Element → \`captureStripeCheckout\`. The second call re-checks everything before money moves, and a payment that can't be recorded afterwards is refunded automatically. A card payment the diner abandons after authorising is still finished by Stripe's webhook or the server's 2-minute sweep, and the diner is told the outcome in their cart's \`notices\` on their next visit.`

export const buildOpenApi = () => ({
    openapi: "3.1.0",
    info: {
        title: "UnQ API",
        version: version(),
        summary: "Order and pay at the table, split the bill, run the shop.",
        description,
        contact: { name: "Hernando Crespo", url: "https://github.com/Nando-C" },
        license: { name: "MIT", identifier: "MIT" },
    },
    externalDocs: { description: "The repository, with the engineering docs", url: "https://github.com/Nando-C/UnQ-BE" },
    servers: [
        { url: env.PUBLIC_API_URL, description: "Where a browser reaches this API (PUBLIC_API_URL): the front end's proxied prefix in production" },
        { url: "/", description: "This host directly" },
    ],
    tags: [
        { name: "Auth", description: "Sign up, sign in, tokens, devices, Google" },
        { name: "Users", description: "The signed-in account" },
        { name: "Accounts", description: "Every account, for administrators: list, create, set a role, delete" },
        { name: "Staff", description: "A shop's members: list, add, remove, hand the shop over" },
        { name: "Shops", description: "Shops and their covers" },
        { name: "Menu", description: "A shop's menu items" },
        { name: "Tables", description: "A shop's tables and their QR URLs" },
        { name: "Carts: ordering", description: "The table's shared order" },
        { name: "Carts: selecting what to pay", description: "Who pays for which units" },
        { name: "Carts: checkout", description: "Paying by PayPal or card" },
        { name: "Manager: tables", description: "What's happening at the tables, and fixing a cart (no money moves)" },
        { name: "Manager: refunds and payments", description: "Refunds, pending payments, pay-backs (money moves)" },
        { name: "Manager: sales", description: "The shop's sales report over its orders" },
        { name: "Payments", description: "The payment providers' callbacks" },
        { name: "System", description: "Health and this document" },
    ],
    security: [{ cookieAuth: [] }],
    paths: {
        ...authPaths, ...userPaths, ...shopPaths, ...menuPaths, ...cartPaths, ...paymentPaths, ...systemPaths,
    } satisfies Paths,
    components: {
        securitySchemes: {
            cookieAuth: { type: "apiKey", in: "cookie", name: "accessToken", description: "Set by the auth routes; refreshed with POST /auth/refreshToken" },
        },
        parameters,
        responses,
        schemas,
    },
})

export type OpenApiDocument = ReturnType<typeof buildOpenApi>
