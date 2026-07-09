/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/tests/**/*.test.ts"],
  setupFiles: ["<rootDir>/src/tests/env.ts"],
  testTimeout: 30000,
}
