import { beforeAll, afterAll, afterEach } from "@jest/globals"
import os from "os"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"

// Import this module from every test file (`import "./setup"`) to get a fresh
// in-memory MongoDB for that file, wired to mongoose with the same global flags
// `src/index.ts` sets in production (`returnDocument: "after"` — controllers rely on
// findOneAndUpdate returning the UPDATED document).

let mongo: MongoMemoryServer

beforeAll(async () => {
    mongo = await MongoMemoryServer.create()
    mongoose.set("returnDocument", "after")
    mongoose.set("strictQuery", true)
    // MongoDB driver 7.6+ loads `os` via dynamic `import()`, which Jest's CommonJS
    // sandbox rejects, so the handshake goes out without its required `driver`
    // metadata and the server refuses it (every query then hangs buffering).
    // Handing the driver `os` directly sidesteps the import. Tests only: plain
    // Node (dev/prod) resolves it fine.
    await mongoose.connect(mongo.getUri(), { runtimeAdapters: { os } })
})

afterEach(async () => {
    const { collections } = mongoose.connection
    for (const key of Object.keys(collections)) {
        await collections[key].deleteMany({})
    }
})

afterAll(async () => {
    await mongoose.disconnect()
    await mongo.stop()
})
