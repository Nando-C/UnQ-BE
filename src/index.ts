import 'dotenv/config'
// Must load before ./server: config is validated at import time, and server.ts
// pulls in oauth.ts, which builds its Google strategy as it is imported.
import env from "./settings/env"
import mongoose from "mongoose"
import app, { routeList } from "./server"
import CartModel, { OPEN_CART_INDEX } from "./services/carts/model"
import ShopModel from "./services/shops/model"
import UserModel from "./services/users/model"
import MenuModel from "./services/menus/model"
import OrderModel from "./services/orders/model"
import StripeCheckoutModel from "./services/carts/stripeCheckout"
import { sweepStripeCheckouts } from "./services/carts/stripeFinish"

const PORT = env.PORT

console.table(routeList())

mongoose.set('returnDocument', 'after')
mongoose.set('strictQuery', true)

mongoose.connect(env.MONGO_CONNECTION)
    .then(() => {
        // Mongoose builds indexes by itself and a failure is otherwise silent;
        // without its index, a lookup reads the whole collection. It goes on
        // to the model's other indexes after one fails, but reports only the
        // first failure, so restart after fixing one to see any other.
        // - Duplicates (11000): a unique index over values that repeat, most
        //   likely the one-open-cart-per-table index while a table still has
        //   two open carts from before it existed.
        // - Conflicts (85, 86): the database already has an index with that
        //   name, or those keys, and other options. Some are unique guards
        //   (replays, one open cart per table): never drop one to make room.
        const hint = (model: string, collection: string, err: Error & { code?: unknown }) =>
            err.code === 11000 && model === "Cart" && err.message.includes(`index: ${OPEN_CART_INDEX} dup key`)
                ? " — list the tables with two open carts: npx tsx src/scripts/findDuplicateOpenCarts.ts"
            : err.code === 11000 ? " — values repeat that the named unique index must keep apart"
            : err.code === 85 || err.code === 86 ? ` — the database already has an index with that name or those keys and other options: compare db.${collection}.getIndexes() with the schema before changing either`
            : ""
        for (const model of [CartModel, ShopModel, UserModel, MenuModel, OrderModel, StripeCheckoutModel] as const) {
            model.init().catch((err: Error & { code?: unknown }) => {
                console.error(` ⚠️  ${model.modelName} indexes not built (${err.message})${hint(model.modelName, model.collection.name, err)}`)
            })
        }
        // The orders' unique payment index first, awaited, so no request
        // arrives before it exists: an order written before it could be
        // doubled. (The rest build in the background, so a long build can't
        // hold the server off; a failure here is logged by the build above.)
        return OrderModel.collection.createIndex({ paymentId: 1 }, { unique: true }).then(() => {}, () => {})
    })
    .then(() => app.listen(PORT, () => {
        console.log("Connected to MongoDB 🌱 ")
        console.log(" ✅  Server is running on port: " + PORT)
        // Surfaces a typo'd PAYPAL_API_BASE, which would otherwise silently
        // leave a "live" deployment talking to the sandbox.
        console.log(` 💳  PayPal: ${env.PAYPAL_MODE} (${env.PAYPAL_API_BASE})`)
        console.log(` 💳  Stripe: ${env.STRIPE_MODE}`)
        // Card payments the diner and the webhook left unfinished
        // (services/carts/stripeFinish.ts). One indexed query when there's
        // nothing to do; a run still going is skipped. Unref'd: it never keeps
        // the process alive on its own.
        setInterval(() => {
            sweepStripeCheckouts().catch((error) => console.error("Card payment sweep failed", error))
        }, 2 * 60 * 1000).unref()
    }))
    .catch((err) => {
        console.log(" 🚫 Database error: ", err);
        process.exit(1)
    })