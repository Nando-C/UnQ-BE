// Lists every table with more than one OPEN cart. The one-open-cart-per-table
// index (carts/model.ts) can't be built while any exist, and Mongoose then runs
// without it (index.ts logs a warning at startup). Read-only: it changes nothing.
//
//   npx tsx src/scripts/findDuplicateOpenCarts.ts
//
// Reads MONGO_CONNECTION from .env (never printed). For each table it shows the
// open carts newest first: the app only ever shows the newest, so the older
// ones are the stranded ones. How to resolve each is a decision per table (move
// unpaid items into the newest cart, or close a stale one); paid units must be
// kept either way.
import "dotenv/config"
import mongoose from "mongoose"
import env from "../settings/env"
import CartModel from "../services/carts/model"

const main = async () => {
    // Don't try to build the index this script exists to unblock.
    await mongoose.connect(env.MONGO_CONNECTION, { autoIndex: false })

    const tables = await CartModel.aggregate<{ _id: string; count: number }>([
        { $match: { status: "open" } },
        { $group: { _id: "$tableId", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { _id: 1 } },
    ])

    if (tables.length === 0) {
        console.log("No table has more than one open cart. The index can be built.")
        return
    }

    console.log(`${tables.length} table(s) with more than one open cart:\n`)
    for (const { _id: tableId, count } of tables) {
        console.log(`Table ${tableId}: ${count} open carts (newest first)`)
        const carts = await CartModel.find({ tableId, status: "open" }).sort({ createdAt: -1 })
        for (const [n, cart] of carts.entries()) {
            const units = cart.items.reduce((sum, i) => sum + i.qty, 0)
            const paid = cart.items.reduce((sum, i) => sum + (i.qtyPayed ?? 0), 0)
            const openSplits = cart.split.filter((s) => s.splitStatus === "open").length
            const created = (cart as unknown as { createdAt?: Date }).createdAt?.toISOString() ?? "?"
            console.log(
                `  ${n === 0 ? "shown   " : "stranded"}  cart ${cart._id}  created ${created}  ` +
                `${cart.items.length} line(s), ${units} unit(s), ${paid} paid, ${openSplits} open split(s)`
            )
        }
        console.log("")
    }
}

main()
    .catch((err: Error) => {
        console.error(err.message)
        process.exitCode = 1
    })
    .finally(() => mongoose.disconnect())
