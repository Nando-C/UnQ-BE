import { Router } from "express"
import { stripeWebhook } from "./stripeWebhook"

const router = Router()

// Stripe's events (no sign-in: trusted by their signature).
router.post("/stripe/webhook", stripeWebhook)

export default router
