// Writes every cart payment's order, or brings it up to date: the backfill
// when orders first ship, and the repair after the server logged "Order not
// written" (a sync that failed after a payment or refund had gone through).
// Safe to run any time, as often as needed: an order is only ever rebuilt from
// its cart, never doubled.
//
//   npx tsx src/scripts/syncOrders.ts
//
// Reads MONGO_CONNECTION from .env (never printed). Prints how many orders it
// created, updated, and found already up to date.
import "dotenv/config"
import mongoose from "mongoose"
import OrderModel from "../services/orders/model"
import { syncAllOrders } from "../services/orders/sync"

const main = async () => {
    const uri = process.env.MONGO_CONNECTION
    if (!uri) throw new Error("MONGO_CONNECTION is not set (.env)")
    await mongoose.connect(uri)
    // One order per payment rests on its unique index: built before any write.
    await OrderModel.init()

    const { created, updated, unchanged, failed } = await syncAllOrders()
    console.log(`Orders: ${created} created, ${updated} updated, ${unchanged} already up to date, ${failed} not written.`)
    // The ones not written are logged above, with why.
    if (failed > 0) process.exitCode = 1
}

main()
    .catch((err: Error) => {
        console.error(err.message)
        process.exitCode = 1
    })
    .finally(() => mongoose.disconnect())
