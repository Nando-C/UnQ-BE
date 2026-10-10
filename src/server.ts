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
export const routeList = () =>
    mounts.flatMap(([base, router]) =>
        router.stack.flatMap((layer) => {
            if (!layer.route) return []
            const prefix = base === "/" ? "" : base
            const path = layer.route.path === "/" ? base : prefix + layer.route.path
            // A route's `all()` layers have no method.
            const methods = new Set(layer.route.stack.map((l) => (l.method ?? "all").toUpperCase()))
            return [...methods].map((method) => ({ method, path }))
        })
    )

// ===================== ERROR HANDLERS =============================
app.use(errorsHandler)

export default app