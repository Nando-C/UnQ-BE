import fs from "fs"
import { spawnSync } from "child_process"

// Runs via jest `setupFiles`, before any test module (and therefore before the
// app under test) is imported, so the token helpers see real secrets at call time.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-access-secret"
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret"
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000"
// Also needed by settings/env.ts's front-end rules: the CORS whitelist is built from
// FRONTEND_DEV_URL/FRONTEND_PROD_URL, so FRONTEND_URL alone does not satisfy it.
process.env.FRONTEND_DEV_URL = process.env.FRONTEND_DEV_URL || "http://localhost:3000"

// The Google OAuth strategy is constructed at import time and throws without a
// clientID, so give it placeholders. The OAuth routes are never exercised in tests.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-google-client-id"
process.env.GOOGLE_SECRET = process.env.GOOGLE_SECRET || "test-google-secret"
process.env.PUBLIC_API_URL = process.env.PUBLIC_API_URL || "http://localhost:3001"

// The app validates its whole configuration at import time (settings/env.ts),
// so every required variable must exist here or importing the app aborts the run.
// These are never dialled: setup.ts connects its own mongodb-memory-server, and the
// Cloudinary, PayPal and Stripe clients are mocked at the module boundary in their suites.
process.env.MONGO_CONNECTION = process.env.MONGO_CONNECTION || "mongodb://127.0.0.1:27017/unq-test"
process.env.CLOUDINARY_URL = process.env.CLOUDINARY_URL || "cloudinary://test-key:test-secret@test-cloud"
process.env.PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "test-paypal-client-id"
process.env.PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "test-paypal-client-secret"
// Stripe's client is mocked too (src/tests/fakeStripe.ts); a test-mode prefix,
// as a real test key has.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy"
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_dummy"

// High enough that no suite meets a rate limit by accident; rateLimits.test.ts
// checks the real ones.
process.env.PASSWORD_FAILS_PER_ACCOUNT = "10000"
process.env.CART_EDITS_PER_MINUTE = "10000"

// bcrypt's lowest cost: the same checks at about half the suite's CPU (it ran
// at 10, and with the test database competing for the machine its health
// checks could time out). Allowed only inside Jest (settings/env.ts).
process.env.BCRYPT_ROUNDS = "4"

// If a mongod binary is already installed locally, point mongodb-memory-server at it
// so the suite never tries to download one. Only use a binary that actually RUNS:
// existing is not enough — an x86_64 mongod left by an old Intel Homebrew exists at
// /usr/local/bin on Apple silicon but can't execute without Rosetta, and memory-server
// then fails and every query hangs buffering until the suite times out. With no
// runnable candidate, memory-server uses its own cached (or downloaded) native binary.
// Override via MONGOMS_SYSTEM_BINARY in the environment.
const runs = (bin: string) => {
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 })
    return probe.status === 0 && /db version v\d/.test(probe.stdout)
}

if (!process.env.MONGOMS_SYSTEM_BINARY) {
    const candidates = ["/usr/local/bin/mongod", "/opt/homebrew/bin/mongod", "/usr/bin/mongod"]
    const found = candidates.find((p) => fs.existsSync(p) && runs(p))
    if (found) process.env.MONGOMS_SYSTEM_BINARY = found
}
