import { beforeAll, afterAll, afterEach } from "@jest/globals"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"

// Import this module from every test file (`import "./setup"`) to get a fresh
// in-memory MongoDB for that file, wired to mongoose with the same global flags
// `src/index.ts` sets in production (`returnOriginal: false` — controllers rely on
// findOneAndUpdate returning the UPDATED document).

let mongo: MongoMemoryServer

beforeAll(async () => {
    mongo = await MongoMemoryServer.create()
    mongoose.set("returnOriginal", false)
    mongoose.set("strictQuery", true)
    await mongoose.connect(mongo.getUri())
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
