// Imported first by rateLimits.test.ts, before the app reads its settings, so
// the real limits apply there instead of the test setup's (see env.ts).
delete process.env.PASSWORD_FAILS_PER_ACCOUNT
delete process.env.CART_EDITS_PER_MINUTE
