# Known gaps

What the API knowingly doesn't do yet, what it accepts as a residual risk, and what is on the list. Kept honest: an item leaves this page when it ships or is decided against, with the changelog saying which.

## Accepted residuals

Reviewed and left as they are, each with its reason.

- **A card payment recorded and refunded.** A finisher that stalls past its 2-minute lease between renewing it and saving the cart can record a payment another finisher has since refunded. Closing it needs a transaction across two collections; instead it is detected, logged as a server error and on the cart's manager log (`stripeRefundedRecorded`), and a pay-back for such a payment is marked `checked`. [payments.md](./payments.md#residual-risks-accepted).
- **PayPal has no webhook or sweep.** A capture whose answer is lost is told to the diner as "contact staff before paying again" with the order id; a refund after a lost race that fails is a `500` with the order id. Staff settle both from PayPal's dashboard.
- **An item that sells out in the instant after a capture** has been paid for and isn't refunded for that.
- **Anyone can lock an account's password** for 15 minutes by guessing wrong 10 times (Google sign-in still works); no per-IP limits until the client address is verified behind the proxies. [decisions.md](./decisions.md#2026-10-05-rate-limits-per-account-not-per-address).
- **Rate-limit counters live in the process**: they reset with a restart and aren't shared between instances.
- **`GET /shops/browse` is public** and a search reads shops and their items until a page is full: the cheapest way to load the database. A per-IP limit waits with the others.
- **A typo in `PAYPAL_API_BASE`'s name** silently selects the sandbox; the boot log's `SANDBOX`/`LIVE` line is the mitigation.
- **A diner disconnected behind the host's proxy** may not be seen as gone (Node only sees it if the proxy closes its upstream connection); such a diner, already told nothing, may get no notice. To be checked on the deployed test mode.
- **`mergeInto` retried after a 409** can double units; merges are unused by the front end.
- **The suite can flake** on the in-memory MongoDB stalling under load (a timeout, `socket hang up`); the failing file is re-run on its own before a failure is treated as real.

## Open bugs

- **`checkPayment` may answer `500` when it reopens a cart.** When a provider declines a pending payment, the check makes its units unpaid again and sets the cart `open`, even one that had closed. If the table has a newer open cart since, the one-open-cart-per-table index should reject that save with a duplicate key, and the manager would get a `500` instead of the two carts to merge the code's comment promises. Noticed 2026-09-29, not reproduced yet; needs a test and a decision (keep the cart closed and move the units, or merge them).
- **The front end matches six checkout messages by their English wording** (`lib/paymentOutcome.ts`) to tell a refund from a plain refusal. Rewording any of them breaks it. Fix: reason codes, deferred item 1 below.

## Deferred

Each changes behaviour, a contract, stored data or several layers at once, so each is a step of its own rather than a tidy-up.

1. **Reason codes on every refusal the front end matches by wording**: additive `reason` fields on the post-capture 409s, the exposed 5xxs, the sold-out and units-held 409s and the table-gone 404 (today only `STILL_CONFIRMING`, `CART_GONE`, `CART_GONE_PENDING` and `superseded` have one). The front end then reads codes, not English.
2. **An outcome code on card payment records**: the finisher decides a refund by comparing a stored message, and a notice is rebuilt by splitting the message on " — ". An `answerCode` beside `status`/`message` would make the wording free to change.
3. **A legacy-data backfill**: set `shopId` on old carts and move `paypalOrderId` into `paypalOrderIds`, then delete the nine `ofTable()` fallbacks, the per-request backfill in `createStripeCheckout`, the duplicate `tableId` partial index and the `$or` in the replay check.
4. **`updatedAt` doubles as a business field** (how long a closed cart stays on the sheet, blocks deletion, carries notices); one writer opts out with `timestamps: false` while two readers rely on it moving. An explicit `activeAt` set by close, payment, refund and check, indexed in its place.
5. **Manager-log idempotency keyed on the message text** (`logOnce`): an explicit key (`stripeRefundFailed:<intentId>`) so rewording doesn't re-log on every webhook retry.
6. **Provider branches outside `lib/payments.ts`**: `checkoutAlreadyUsed`, `recordedOnCart` vs `orderAlreadyUsed`, `hasCheckoutRecord = provider === "stripe"`; one `checkoutRecorded(provider, id)` and a traits map per provider. The currency is a literal `GBP` until shops carry one.
7. **`decreaseSplitItem` takes one unit per call**; an additive `qty` would let the front end send one request.
8. **The Stripe webhook's raw body** is a per-route exception inside the global JSON parser, with a hand-rolled URL check; mounting `express.raw()` on that path would be cleaner but the startup route listing forbids app-level routes. Decide the two together.
9. **Cart archiving**: once orders hold the history, closed carts should expire about 30 days after closing, through an `expiresAt` set on close and unset while a payment or refund awaits a provider (a TTL filter can't express the `$or`). Decided, not built.
10. **Two contract wrinkles**, kept until the front end's handling changes with them: `"Shop Not Found or you are not authorized!"` is a `400` where `404`/`403` would fit; `PUT /shops/:shopId/tables/:tableId` answers the shop's whole tables array, not the table.
11. Smaller: `decreaseItem` runs an unconditional delete-and-close after every `−`; `changeMySplit`'s precheck repeats the update's 404; `optionalJWT` loads the whole user for the public cart; `GET /shops` still answers every shop with its menu though the front end moved to `/shops/browse`; `heldSince` in the table status is sent but never read; the test files' `scaffold` could be shared.

## Roadmap

In the order decided with the product roadmap, now that the sales report and its export are in: the **sales dashboard**, which reads the report route with fixed ranges; **staff on a shop** (today a shop's only member is the manager who created it; nothing adds a second) and then **staff roles** narrowing what each member can do; **kitchen** (queue, prep states, live push); **live payment keys**, a deliberate switch rather than a release step.
