// Runs via jest `setupFiles`, before any test module (and therefore before the
// app under test) is imported, so the token helpers see real secrets at call time.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-access-secret"
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret"
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000"

// The Google OAuth strategy is constructed at import time and throws without a
// clientID, so give it placeholders. The OAuth routes are never exercised in tests.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-google-client-id"
process.env.GOOGLE_SECRET = process.env.GOOGLE_SECRET || "test-google-secret"
process.env.BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001"

// If a mongod binary is already installed locally, point mongodb-memory-server at it
// so the suite never tries to download one. Only set the var when the binary actually
// exists — pointing memory-server at a missing path would make it fail rather than
// fall back to downloading. Override via MONGOMS_SYSTEM_BINARY in the environment.
if (!process.env.MONGOMS_SYSTEM_BINARY) {
    const fs = require("fs") as typeof import("fs")
    const candidates = ["/usr/local/bin/mongod", "/opt/homebrew/bin/mongod", "/usr/bin/mongod"]
    const found = candidates.find((p) => fs.existsSync(p))
    if (found) process.env.MONGOMS_SYSTEM_BINARY = found
}
