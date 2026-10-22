# Decisions

The choices that shape the API and why they were made, as a log. Each is the context at the time, the decision, and what it costs or commits to. Dates are when the decision was taken during the 2026 rebuild; the code that implements each is named so it can be checked.

## 2026-07-12: charge only after reserving, refund a race lost after capture

**Context.** The first checkout let the PayPal SDK in the browser capture the money, then asked the server to record it. The server could refuse to record, never prevent the charge: every refusal was a "contact staff" incident, and two diners paying for the same last unit were both charged.

**Decision.** The server creates the provider's order or intent for the amount it computed (step 1), the diner approves it, and the server captures only after re-checking the cart (step 2). A race lost in the instant after capture is refunded automatically. The client-trust endpoints were removed once the front end had moved.

**Consequences.** Every payment costs two server calls and a verification of the provider's answer. Amounts never come from the client. A refusal before capture costs nothing (the order expires, the hold is released); the one remaining "contact staff" case is a refund that fails after a capture. Carried over unchanged to Stripe (manual capture gives the same shape). `controllers.ts` `createCheckoutOrder`/`captureCheckout`, `stripeFinish.ts`.

## 2026-07-11: a cart's version, not timestamps, orders concurrent writes

**Context.** Mongoose's default versioning only guards array-structure changes; two diners' payments on one cart could both save and lose each other's `qtyPayed`. Server clocks can't order writes from several processes.

**Decision.** `optimisticConcurrency: true` on carts: every `save()` is version-checked on any modified path, retried a bounded number of times from a fresh read, and answered `409 "The cart changed, please retry"` when it can't win. Everything that changes a payment or a refund goes through such a save, so the cart's `__v` orders them; an order is written only over one built from the same or an older version (`cartVersion`), never by `updatedAt`.

**Consequences.** Manager actions and diners' payments can't overwrite each other; a settlement either records everything or nothing. The cost is a retry loop at each writer and a few spurious 409s at a busy table. Checks that only need to be approximate (`addSplitItem`'s availability) use an atomic update instead. `carts/model.ts`, `settleCheckout`, `saveChecked`, `orders/sync.ts`.

## 2026-10-07: one finisher per card payment, by claim and lease, not by idempotency keys

**Context.** A card payment can be finished by the diner's request, Stripe's webhook and a sweep, often within milliseconds of each other. Stripe's idempotency keys can't keep them apart: a second request sent while the first runs gets a 409, and a cached error is replayed for 24 hours. One finisher refunding while another records would lose money.

**Decision.** Each intent has a record with a claim: a random token and a 2-minute lease. Only the holder acts, every write matches its token, and a write that matches nothing means stop. The route waits 8 seconds for another finisher; the webhook answers 200 and leaves it; the sweep takes over expired leases. The cart stays the truth for "paid".

**Consequences.** A `StripeCheckout` record per intent, kept as an audit trail and as the carrier of the diner's notice. A holder that stalls past its lease between renewing and saving is a residual risk, detected and logged rather than prevented (a transaction across record and cart was judged not worth it). Reviewed three times before building; see [payments.md](./payments.md#card-payments-one-finisher).

## 2026-10-07: a refund Stripe fails later is not reversed; money Stripe won't return becomes a pay-back

**Context.** Stripe can accept a refund and report it failed days later (a closed card), or refuse one outright (a dispute). Reversing a manager's refund on the cart would make the app say "paid" for units already given back.

**Decision.** Nothing is reversed. The diner is owed the money, so it becomes a pay-back: a record on its own, flagged on the table until a manager marks it done, with `disputed` when the diner's bank is returning it instead. Deleting a shop waits for 30 days after a card refund last moved, the window in which Stripe can still report one failed.

**Consequences.** A second money record beside orders, and a rule that holds up shop deletion for a month. Staff see a debt, not a reversed sale. `payments/payback.ts`, `stripeDeletion.ts`.

## 2026-10-06: orders are a separate collection, one per payment

**Context.** The sales report needed what was sold, at what price, by whom, on which day, and refunds with reasons. Carts are deleted with their tables and shops, prices change, menu items get deleted.

**Decision.** An `Order` per cart payment, rebuilt from the cart as saved (`syncOrder`) after every change to a payment or refund, unique by payment id, kept when the cart, table, menu item or shop goes. The cart stays the source of truth; a sync that fails is logged and repaired by a script, never fails the request (the money already moved).

**Consequences.** Two places hold the same facts, reconciled one way. Shop deletion writes every missing or stale order before the carts go, and refuses if it can't. Refund reasons were added to the cart's refund for the order to copy. `orders/sync.ts`, `src/scripts/syncOrders.ts`.

## 2026-09-28: refunded units are cancelled; closing a table drops unpaid units; diners are told

**Context.** Managers had no way to see a cart or a payment. When they got one, three product questions had to be answered: what a refund does to the cart, what closing a table does, and whether diners learn about it.

**Decision.** Refunded units leave the cart (they don't become payable again). Closing a table keeps paid units and drops unpaid ones (the kitchen acts on paid orders only). Diners get a note on their cart for a released selection, a removed item, a closed table and a refund. Any manager of the shop can do all of it; roles come later.

**Consequences.** The cart's items and selections shrink on refund, which the diner's view shows; closed carts carry notices that only the diners who took part see, for 2 hours. `managerControllers.ts`.

## 2026-09, manager tools: deleted tables are kept under the shop; a shop deletion waits for money

**Context.** A table's carts, payments and refunds are reachable by its id. Deleting the table subdocument would orphan them, and a shop deletion while a payment is pending would lose the only place it can be settled.

**Decision.** A deleted table moves to the shop's `deletedTables` (its carts stay readable from `/shops/me`); a shop is deleted only when no table has an open cart, no payment or refund awaits a provider, no card money is still moving, and no paid cart has changed for a day. Orders and pay-backs survive it; the shop's carts, menu and tables go.

**Consequences.** Lookups by table check both arrays (`ofTable`); a shop can't be deleted on a whim, and the refusal says what to do first. `shops/model.ts`, `deleteMyShop`.

## 2026-10-05: rate limits per account, not per address

**Context.** Behind the front end's rewrite and the host's proxies, every visitor's address looks like Vercel's or can be faked through `X-Forwarded-For`; a venue's diners share one address anyway.

**Decision.** Wrong passwords are limited per account (10 in 15 minutes, counted wherever a password is compared) and a diner's cart edits per account (120 a minute, including starting a card checkout; capturing never). No per-IP limits until the client address is verified in production. Counts live in memory.

**Consequences.** Anyone can lock an account's password out for 15 minutes (Google sign-in still works); sign-up has no limit yet. `lib/passwordLimit.ts`, `middlewares/rateLimits.ts`.

## 2026-08-30: configuration fails fast, with one accepted blind spot

**Context.** Scattered `process.env.X!` reads let a missing variable produce a running server with a quietly broken feature (`undefined/auth/googleRedirect`), and a missing `PAYPAL_API_BASE` silently meant the sandbox.

**Decision.** One zod schema, parsed once at import, printing every problem (names only) and exiting. Unknown keys are stripped, not rejected. `PAYPAL_API_BASE` keeps its sandbox default, so a typo in its name isn't caught; the boot log printing the resolved mode is the accepted mitigation.

**Consequences.** Tests must set every required variable; import order in `index.ts` matters (validate before the OAuth strategy is built). `settings/env.ts`.

## 2026-07-11: a sparse unique index on an array needs `default: undefined`

**Context.** Replay protection moved from a scalar `paypalOrderId` to the array `paypalOrderIds` with a unique sparse index. Mongoose defaults an array field to `[]`, which MongoDB indexes under the key `undefined`, and a sparse index does **not** skip that key: every cart without a payment collided.

**Decision.** Every unique sparse array field (`paypalOrderIds`, `stripePaymentIntentIds`) is declared with `default: undefined` and created lazily on first push. The legacy scalar is still read, never written.

**Consequences.** A rule future fields must follow; a backfill that moves the legacy scalar into the array is still owed (see [known-gaps.md](./known-gaps.md)). `carts/model.ts`.

## 2026-10-07: Stripe's Payment Element in UnQ's checkout, cards only, GBP

**Context.** Adding cards and wallets beside PayPal. Stripe's hosted checkout page would take the diner away from the table and the server would lose control of when money moves; bank debits and pay-later methods settle days later.

**Decision.** The Payment Element inside the checkout, with manual capture so the server captures after its checks, as with PayPal. Cards only, which brings Apple Pay and Google Pay. GBP, as PayPal. Both Stripe keys required at boot.

**Consequences.** Wallets appear only on an HTTPS page whose exact domain is registered in Stripe's dashboard. The pinned API version in `lib/stripe.ts` is the only place Stripe's shapes can change under the code. The currency is a literal in the checkout checks until a shop-level setting exists.

## 2026-10-09: the contract is an OpenAPI document built from the code

**Context.** The README listed every route and model by hand and had drifted (a rate-limit claim, a model name). The front end depends on the exact paths and shapes.

**Decision.** `src/openapi/` builds an OpenAPI 3.1 document: request bodies from the zod schemas the routes validate with, responses and messages written from the controllers and verified against them. A test keeps it listing exactly the served routes and valid against the OpenAPI schema; another keeps the README's variable table, `.env.example` and every Markdown link in step. The contract is frozen for the front end; changes are additive.

**Consequences.** Every new route, field, status or message is a change to the document in the same commit. Swagger UI is one HTML route loading a pinned CDN build, because the startup route listing forbids non-route middleware on the routers.

## 2026-10-11: a session per device, on the user document

**Context.** An account held one refresh token: a sign-in on a second device ended the first's session at its next refresh, within 15 minutes. A manager couldn't stay signed in on the laptop and the phone, and on the shared demo accounts one visitor signed another out.

**Decision.** `sessions[]` on the user, one per sign-in: the id of the refresh token the device holds (never the token), the id it held before its last rotation and when, the sign-in and last-refresh times, the User-Agent. Both tokens carry the session's id. At most 10 per account, the oldest sign-in going beyond that; a sign-in sweeps sessions that haven't refreshed in four weeks. Rotation stays one conditional `updateOne`, now matched on the session's token id. Logout ends one device; `GET /auth/sessions` and `DELETE /auth/sessions/:sessionId` list and revoke; a password change still ends every other session.

**Consequences.** Tokens issued before this belong to no session, so deploying it signs every current session out once; the old `refreshToken` field stays on existing documents, unread. "Superseded" is now told only to the device that rotated the token, so a stale token from a revoked device ends at once instead of after a minute. The cap is a ceiling on the document's size, not a product rule: an eleventh device signs in and the first signs out. `users/model.ts`, `auth/tools.ts`, `auth/controllers.ts`.

## 2026-10-12: sales are counted as at a till, in the shop's own day

**Context.** The orders collection had been written for a sales report with no report to read it. The numbers a manager compares (today against last week, this month against last) only hold if every figure follows one stated rule, and a server in UTC would put a late sale on the wrong day for a shop in London half the year.

**Decision.** One route, `GET /shops/:shopId/sales`, counts the way a till does. Gross is completed payments by the day paid; refunds count on the day they were made, whenever their sale was; net is the difference. Visits are distinct carts, diners distinct payers, a returning diner one who had paid before the range began. Items are net of refunded units under the name and price diners saw last. Days are the shop's: a `timeZone` on the shop (an IANA name, `Europe/London` unless set) and the database's own zone-aware bucketing (`$dateTrunc`, `$hour`, `$isoDayOfWeek`), weeks from Monday. The comparison with the period before is computed on the server in the same answer, and the series is zero-filled there, so a page never recomputes a total or invents a gap.

**Consequences.** A refund lowers the month it was made in, not the sale's: the two totals of a month can move apart after it closes, which is what a till shows too. The report answers in the shop's zone and says so; a manager who changes the zone changes every past day's boundary. Everything the page shows comes from one answer of bounded size, so a new metric is a client change, not a route. `shops/controllers/salesControllers.ts`, `lib/days.ts`, `shops/model.ts`.

## 2026-10-17: staff are provisioned down a chain, by email, with no invitation

**Context.** A shop had exactly one member, the account that created it, and nothing could add a second; the roles step after this one needs several. The question was how a second person comes to be on a shop: an invitation they accept (needing a mailer, or an in-app inbox, and something that waits and expires), a shareable code, or an account made for them.

**Decision.** Accounts are made by the person above them, and told their first password. One account role above every shop, `admin`, set in the database for the first one and given from there; owners add their shop's managers; from the roles step, managers add the roles below manager. Adding is by email, **create or attach**: an address with an account is attached as it is, one without gets an account created from the name, surname and password sent. No mailer, no code, nothing pending. Who may act on a shop is read per request from the shop document the guard already loads, never from the token, so a removal is immediate. Handing the shop over has its own path (`PUT /shops/:shopId/owner`) rather than a reserved word under `/staff/:userId`, which Express would take for a user id.

**Consequences.** The person who adds staff knows them and sees them, so the hand-off of the first password happens where the hire is; the account exists the moment the owner presses Add. Three residuals are accepted and listed in [known-gaps.md](./known-gaps.md#accepted-residuals): the owner knows the first password until it is changed; attaching adds an existing account to a shop without that account agreeing (they see the shop under My Shops and can leave with one press); an account created at an address someone else owns is theirs once they sign in with Google, memberships included. The public demo's manager password now reaches these routes, so people added are rate-limited per caller. `shops/controllers/staffControllers.ts`, `users/controllers.ts`, `auth/middlewares.ts`.

## 2026-10-22: routes check abilities, not roles; the ability travels in the contract

**Context.** The roles step adds till, floor and kitchen under owner and manager, and twenty-four shop routes need to say which roles may call them. Naming roles on each route would put the same list in two dozen places and in the front end's buttons; permissions per entity and CRUD verb fit these routes badly (no cart is created or deleted by staff; the one menu edit route splits by body, not by verb); and a venue may one day want to define its own roles.

**Decision.** Each route names one **ability** (`shop.edit`, `payments.manage`, …, ten in all) and one table, `shops/roles.ts`, says which roles hold it; `can(role, ability)` is the only place a role becomes abilities, and an administrator holds every one. The guard is `allows(ability)` after `isShopManager`, with one refusal for every ability. Every guarded OpenAPI operation publishes `x-ability`, what the server checks, and `x-roles`, the roles holding it today, both written from the same table; the API's test reads the guard off each route and checks the document, and the front end's contract test is to check its own mirror against the same fields. The availability switch and the menu editor share one route, so its guard reads the validated body: `available` alone is one ability, anything else the other.

**Consequences.** Adding a role is a column; the routes, the tests of the wiring and the client's checks do not change. Were roles ever a shop's own, `can()` would read the shop's table, `x-ability` would stay true on every operation and `x-roles` would become the defaults a new shop starts from: the document keeps its shape. The client mirrors the table rather than asking the server what to draw, which is one more copy to keep equal; the contract test is what keeps it so, and [known-gaps.md](./known-gaps.md) records it. `auth/middlewares.ts`, `shops/roles.ts`, `openapi/helpers.ts`, `tests/openapi.test.ts`, `tests/roles.test.ts`.
