// ===================== PACKAGES ===================================
import express, { Router } from "express"
import cors from "cors"
import passport from "passport"
import googleStrategy from "./services/auth/oauth"
import cookieParser from "cookie-parser"

import { errorsHandler } from "./errorMiddlewares"
import { corsOptions } from "./settings/cors"

// ===================== ROUTERS ====================================
import authRouter from "./services/auth/routes"
import userRouter from "./services/users/routes"
import shopRouter from "./services/shops/routes"
import menuRouter from "./services/menus/routes"
import cartRouter from "./services/carts/routes"
import paymentRouter from "./services/payments/routes"
import systemRouter from "./openapi/routes"
import { isStripeWebhook } from "./lib/stripeWebhook"


const app = express()
passport.use("google", googleStrategy)

// ===================== MIDDLEWARES ================================
// Stripe's webhook is trusted by a signature over the body's exact bytes:
// kept for that path only (a re-serialised body wouldn't verify).
app.use(express.json({
    verify: (req, _res, buf) => {
        if (isStripeWebhook(req.url)) (req as express.Request).rawBody = buf
    },
}))
// Behind the host's proxy: trust its X-Forwarded-* headers (client IP, https).
app.set('trust proxy', 1)
app.use(cors(corsOptions))
app.use(cookieParser())
app.use(passport.initialize())

// ===================== ENDPOINTS  =================================
// Each service's router and where it's mounted. Menu routes live under
// /shops/:shopId/menu, next to the shop routes. The API's own routes (health,
// the OpenAPI document and its UI) are at the root.
export const mounts: [string, Router][] = [
    ["/auth", authRouter],
    ["/users", userRouter],
    ["/shops", shopRouter],
    ["/shops", menuRouter],
    ["/carts", cartRouter],
    ["/payments", paymentRouter],
    ["/", systemRouter],
]
for (const [path, router] of mounts) app.use(path, router)

// Every route, a row per method (listed at startup). From the mounts above:
// Express 5 doesn't keep a mounted router's path where a library can read it
// back, so routes must be in a mounted router, not nested deeper or on `app`,
// and declared with plain string paths (routeList.test.ts checks).
const routes = () =>
    mounts.flatMap(([base, router]) =>
        router.stack.flatMap((layer) => {
            if (!layer.route) return []
            const prefix = base === "/" ? "" : base
            const path = layer.route.path === "/" ? base : prefix + layer.route.path
            // A route's `all()` layers have no method.
            const methods = new Set(layer.route.stack.map((l) => (l.method ?? "all").toUpperCase()))
            // The guard that decides by the caller's role on the shop, if the
            // route has one (auth/middlewares.ts AbilityGuard).
            const guard = layer.route.stack.map((l) => l.handle as { abilities?: readonly string[] }).find((h) => h.abilities)
            return [...methods].map((method) => ({ method, path, abilities: guard?.abilities }))
        })
    )
export const routeList = () => routes().map(({ method, path }) => ({ method, path }))
// Each route's ability guard, for the OpenAPI test: "METHOD path" → the
// abilities it checks, or undefined for a route without one.
export const routeAbilities = () => new Map(routes().map(({ method, path, abilities }) => [`${method} ${path}`, abilities]))

// ===================== ERROR HANDLERS =============================
app.use(errorsHandler)

export default app