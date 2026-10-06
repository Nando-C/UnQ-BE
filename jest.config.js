/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/tests/**/*.test.ts"],
  setupFiles: ["<rootDir>/src/tests/env.ts"],
  // Room for a busy machine: a stall shorter than this waits instead of
  // failing (see src/tests/setup.ts for the database side).
  testTimeout: 60000,
}
