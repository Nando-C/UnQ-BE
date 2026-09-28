import 'dotenv/config'
// Must load before ./server: config is validated at import time, and server.ts
// pulls in oauth.ts, which builds its Google strategy as it is imported.
import env from "./settings/env"
import mongoose from "mongoose"
import listEndpoints from "express-list-endpoints"
import app from "./server"
import CartModel from "./services/carts/model"

const PORT = env.PORT

console.table(listEndpoints(app))

mongoose.set('returnDocument', 'after')
mongoose.set('strictQuery', true)

mongoose.connect(env.MONGO_CONNECTION)
    .then(() => {
        // Mongoose builds indexes by itself and a failure is otherwise silent.
        // The one that can fail is the one-open-cart-per-table index, while a
        // table still has two open carts from before it existed.
        CartModel.init().catch((err: Error) => {
            console.error(" ⚠️  Cart indexes not built (" + err.message + ") — list the tables with two open carts: npx tsx src/scripts/findDuplicateOpenCarts.ts")
        })
    })
    .then(() => app.listen(PORT, () => {
        console.log("Connected to MongoDB 🌱 ")
        console.log(" ✅  Server is running on port: " + PORT)
        // Surfaces a typo'd PAYPAL_API_BASE, which would otherwise silently
        // leave a "live" deployment talking to the sandbox.
        console.log(` 💳  PayPal: ${env.PAYPAL_MODE} (${env.PAYPAL_API_BASE})`)
    }))
    .catch((err) => {
        console.log(" 🚫 Database error: ", err);
        process.exit(1)
    })