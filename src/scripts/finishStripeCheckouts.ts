// Finishes the card payments left unfinished, as the server does every 2
// minutes (services/carts/stripeFinish.ts): authorised intents the diner and
// the webhook never finished are captured and recorded (or released if the
// cart changed), claims whose holder stopped are taken over, and intents still
// unauthorised an hour after they were created are cancelled. Ones still
// unfinished two hours after they started are logged. Safe to run any time,
// beside the server: one finisher at a time per payment.
//
//   npx tsx src/scripts/finishStripeCheckouts.ts
//
// Reads MONGO_CONNECTION and the Stripe key from .env (never printed). Prints
// what it did.
import "dotenv/config"
import mongoose from "mongoose"
import env from "../settings/env"
import { sweepStripeCheckouts } from "../services/carts/stripeFinish"

const main = async () => {
    // As index.ts: findOneAndUpdate returns the updated document.
    mongoose.set("returnDocument", "after")
    mongoose.set("strictQuery", true)
    await mongoose.connect(env.MONGO_CONNECTION)

    // The only run in this process, so never skipped.
    const { finished, released, refunded, handedOver, left, failed } = (await sweepStripeCheckouts())!
    console.log(`Card payments (Stripe ${env.STRIPE_MODE}): ${finished} recorded, ${released} released (nothing taken), ${refunded} refunded, ${handedOver} handed to staff (Stripe won't refund them), ${left} left (in use or held), ${failed} failed.`)
    if (failed > 0) process.exitCode = 1
}

main()
    .catch((err: Error) => {
        console.error(err.message)
        process.exitCode = 1
    })
    .finally(() => mongoose.disconnect())
