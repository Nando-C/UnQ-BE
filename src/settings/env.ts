import { z } from "zod"

// Single source of truth for configuration. Parsed once, at import time, so a missing
// or empty variable stops the process here instead of surfacing later as a quietly
// broken feature — an unset PUBLIC_API_URL used to make the Google callback the literal
// string "undefined/auth/googleRedirect" while the server booted perfectly.
//
// Unknown keys are stripped rather than rejected (no .strict()): process.env always
// carries unrelated entries — PATH, HOME, whatever the host injects, MONGOMS_SYSTEM_BINARY
// under Jest — so a strict schema would refuse to start in every environment.

// `.env` lines written as `KEY=` arrive as "", so required values check length, not just
// presence; optional ones treat "" as absent so an empty line behaves like a missing one.
const required = z.string().min(1)
const optional = z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional()
)

const envSchema = z
    .object({
        PORT: z.coerce.number().int().positive().default(3001),

        MONGO_CONNECTION: required,
        JWT_SECRET: required,
        JWT_REFRESH_SECRET: required,

        GOOGLE_CLIENT_ID: required,
        GOOGLE_SECRET: required,

        // Where a BROWSER reaches this API — not necessarily this server's own origin.
        // When the front-end proxies the API through its origin this is that proxied
        // prefix (e.g. https://un-q.vercel.app/api); Google's OAuth callback is built
        // from it, so pointing it at this host directly sets the auth cookies on a
        // domain the front-end can never read.
        PUBLIC_API_URL: required,

        // Read by the cloudinary SDK itself, never by our code — which is exactly why it
        // is validated here. It is invisible to grep, so its absence would otherwise only
        // show up as a failing upload at runtime.
        CLOUDINARY_URL: required,

        PAYPAL_CLIENT_ID: required,
        PAYPAL_CLIENT_SECRET: required,
        // Defaults to sandbox on purpose. Note this means a *typo* in this variable name
        // silently leaves you on sandbox, which is why index.ts logs the resolved mode.
        PAYPAL_API_BASE: z.string().min(1).default("https://api-m.sandbox.paypal.com"),

        // Individually optional, but constrained in pairs by the rules below.
        FRONTEND_URL: optional,
        FRONTEND_DEV_URL: optional,
        FRONTEND_PROD_URL: optional,
    })

const parsed = envSchema.safeParse(process.env)

// The two front-end rules are checked here rather than as object-level .refine()s:
// zod skips refinements entirely when the base parse fails, so on a half-configured
// deployment they would stay hidden until a second run — defeating the whole point of
// reporting everything at once.
const isSet = (value?: string) => Boolean(value && value.trim())
const pairProblems: string[] = []
if (!isSet(process.env.FRONTEND_URL) && !isSet(process.env.FRONTEND_DEV_URL)) {
    pairProblems.push(
        "FRONTEND_URL: at least one of FRONTEND_URL or FRONTEND_DEV_URL must be set — OAuth redirects and generated table QR URLs are built from it"
    )
}
if (!isSet(process.env.FRONTEND_DEV_URL) && !isSet(process.env.FRONTEND_PROD_URL)) {
    pairProblems.push(
        "FRONTEND_DEV_URL: at least one of FRONTEND_DEV_URL or FRONTEND_PROD_URL must be set — the CORS whitelist is built from exactly these two"
    )
}

if (!parsed.success || pairProblems.length > 0) {
    // Report every problem at once so a fresh deployment is configured in one pass
    // rather than one failed boot per variable. Names only — several are secrets.
    console.error("\n❌ Invalid environment configuration:\n")
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            console.error(`   • ${issue.path.join(".") || "(config)"}: ${issue.message}`)
        }
    }
    for (const problem of pairProblems) console.error(`   • ${problem}`)
    console.error("\nSee .env.example for the full list of variables.\n")
    process.exit(1)
}

const data = parsed.data

export const env = Object.freeze({
    ...data,

    // The front-end origin used for OAuth redirects and generated table QR URLs.
    // The first refinement guarantees one of the two is present.
    FRONTEND_ORIGIN: (data.FRONTEND_URL ?? data.FRONTEND_DEV_URL) as string,

    // The CORS whitelist is exactly the dev + prod front-end origins. The second
    // refinement guarantees at least one survives the filter.
    CORS_WHITELIST: [data.FRONTEND_DEV_URL, data.FRONTEND_PROD_URL].filter(
        (origin): origin is string => Boolean(origin)
    ),

    // Whether PayPal calls resolve to the sandbox or the live API.
    PAYPAL_MODE: data.PAYPAL_API_BASE.includes("sandbox") ? "SANDBOX" : "LIVE",
})

export default env
