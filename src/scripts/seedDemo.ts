// Writes the demo data (see demo.ts for what it is): three shops with menus and
// tables, a manager and eight diners, 90 days of payments and refunds, and the
// live states a manager's page shows. Reproducible, and scoped: a rerun
// rewrites only what the seed owns (the demo shops' records and its users) and
// leaves everything else in the database alone.
//
//   npm run seed:demo
//
// Reads MONGO_CONNECTION, DEMO_MANAGER_PASSWORD and DEMO_DINER_PASSWORD from
// .env (never printed) and refuses to run without the two passwords. Prints the
// sign-in emails and what it wrote.
import "dotenv/config"
import mongoose from "mongoose"
import env from "../settings/env"
import UserModel from "../services/users/model"
import ShopModel from "../services/shops/model"
import MenuModel from "../services/menus/model"
import CartModel from "../services/carts/model"
import OrderModel from "../services/orders/model"
import StripeCheckoutModel from "../services/carts/stripeCheckout"
import PaybackModel from "../services/payments/payback"
import { seedDemo } from "./demo"

const main = async () => {
    const { DEMO_MANAGER_PASSWORD: managerPassword, DEMO_DINER_PASSWORD: dinerPassword } = env
    if (!managerPassword || !dinerPassword) {
        throw new Error("Set DEMO_MANAGER_PASSWORD and DEMO_DINER_PASSWORD in .env: the demo's two sign-ins")
    }

    await mongoose.connect(env.MONGO_CONNECTION)
    // Every unique index first (one open cart per table, one order per payment,
    // one pay-back per cause), so the seed is checked by them as the app is.
    for (const model of [UserModel, ShopModel, MenuModel, CartModel, OrderModel, StripeCheckoutModel, PaybackModel]) await model.init()
    console.log(`Seeding the demo into database "${mongoose.connection.name}"…`)

    await seedDemo({ managerPassword, dinerPassword, log: console.log })
    console.log("Done. The demo shop's QR table: /shops/6158a19282eaef10787cd6f3/tables/61702525cc1ec6af70a92f35")
}

main()
    .catch((err: Error) => {
        console.error(err.message)
        process.exitCode = 1
    })
    .finally(() => mongoose.disconnect())
