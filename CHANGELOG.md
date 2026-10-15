# Changelog

All notable changes to the UnQ API. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

UnQ ships as two repositories that release together. A front-end release `x.y.*` needs this API at `x.y.0` or later; the shared MINOR says which pair belong together. Patches are independent. The MAJOR changes only when a release needs a change on the deployment host (new variables, a new webhook, a deploy order) or breaks a route the front end uses.

## [Unreleased]

### Added

- A nightly reseed of the deployed demo: a GitHub Actions workflow (`.github/workflows/demo.yml`) runs `npm run seed:demo` at 03:30 UTC every day, and on demand, from three repository secrets, so the demo's ninety days always end yesterday. [docs/operations.md](./docs/operations.md#the-demo-data).

### Changed

- The demo seed's occasional diners each make a first visit at one of the shops, spaced over the ninety days rather than all at the start, so every shop's report has new faces in any month and in the last seven days, and its returning share is never everyone. The live table states sit at the latest moment the shop was open, so a seed run at night writes no order outside the shop's hours. A reseed rewrites the demo shops' history, as every rerun does.

## [2.2.0] - 2026-10-12

Several devices per account, and the sales report over the orders recorded since 2.0.0. Nothing new on the host. Deploying signs every current session out once (the tokens in hand belong to no session); signing in again is all it takes. A deployed demo wants the seed run again, with `FRONTEND_URL` set to the live client, so its history has the shapes the report shows.

### Added

- Several devices per account. Each sign-in is a session of its own on the account (up to ten; the oldest goes beyond that), so signing in on a second device no longer signs the first out, and a logout ends only that device's session. `GET /auth/sessions` lists the devices signed in, the caller's marked `current`; `DELETE /auth/sessions/{sessionId}` signs one out (its next refresh fails, so it is a guest's within 15 minutes). A password change still ends every other session. [docs/auth.md](./docs/auth.md#sessions-are-two-cookies).
- The sales report: `GET /shops/{shopId}/sales?from&to[&by][&compare=previous]`, for the shop's manager, over the orders recorded since 2.0.0. Totals, a zero-filled series by day, week or month, sales by weekday and hour, items by revenue, refunds by reason and hour, the tables, and the period before for comparison, counted as a till does: gross by the day paid, refunds by the day made, net the difference, all in the shop's own days. [docs/api.md](./docs/api.md#sales-report).
- A time zone on the shop (`timeZone`, any IANA name the server can format dates in, `UTC` included, saved under its canonical spelling, `Europe/London` unless set) on `POST /shops` and `PUT /shops/{shopId}`, shown with the shop: the zone its days are counted in.
- `GET /shops/{shopId}/sales/export?from&to&table=orders|items|days`: one of the report's tables as a CSV download, counted the same way, with no diner named; UTF-8 with a byte-order mark, and cells that would read as a spreadsheet formula made safe.

### Changed

- A session stores its refresh token's id, never the token, and both tokens name their session. Deploying this signs every current session out once (the tokens in hand belong to no session); the old `refreshToken` field is left unread on existing accounts.
- The demo seed writes forty diners (a dozen regulars) and a history shaped for the sales report: busy spells, a gentle rise over the 90 days, a pastry launched in week six, refund causes weighted with long waits on busy evenings, and one bad week at the café. Its days and hours are the shops' own (`Europe/London`) wherever it runs. A reseed rewrites the demo shops' history, as every rerun does.

## [2.1.0] - 2026-10-11

The documentation release: the API's contract as an OpenAPI document, the design knowledge under `docs/`, the README as a front page, and a demo seed. Nothing changes on the host. To seed a deployed database, run the seed with `FRONTEND_URL` set to the live client.

### Added

- `LICENSE`: MIT, with the licence badge.
- `npm run seed:demo`: a reproducible demo (three shops, a manager and eight diners, 90 days of payments and refunds, the live table states, orders through the real sync), rewriting only what it owns on a rerun; its two sign-ins take their passwords from `DEMO_MANAGER_PASSWORD` and `DEMO_DINER_PASSWORD`. Tested twice over against the in-memory database (`src/tests/seedDemo.test.ts`).
- The API's contract as an OpenAPI 3.1 document built from the code (request bodies from the routes' zod schemas), served at `GET /openapi.json` with Swagger UI at `GET /docs`. A test keeps it listing exactly the routes the server serves and validating against the OpenAPI schema (`src/openapi/`, `src/tests/openapi.test.ts`).
- `GET /health`: `{ status, version, uptime }`.
- `docs/api.md` (conventions, rate limits, checkout, Stripe's webhook) and `docs/data-model.md` (the seven collections, field by field) replace the README's Models and REST API sections.
- `src/scripts/validateOpenApi.mjs`: validates a served or saved OpenAPI document.
- `docs/payments.md` (how money moves and the rules that hold), `docs/auth.md` (sessions, passwords, Google sign-in, roles), `docs/operations.md` (start-up, configuration, deploying, repair scripts), `docs/decisions.md` (the choices behind the API) and `docs/known-gaps.md` (accepted residuals, open bugs, deferred work).
- Docs drift tests: the README's variable table and `.env.example` list exactly the environment schema's keys, and every relative link and anchor in the Markdown files resolves (`src/tests/docs.test.ts`).

### Changed

- CI runs on pushes to `main` and on pull requests, not on every branch.
- The README is a front page: what it does, what it has to get right, the decisions with their reasons, one diagram, the quick start with where each credential comes from and how to become a manager locally, testing and CI, the docs index, the roadmap. The checkout sequence diagram moved to `docs/api.md`; the dependency override and the versioning rule live in `docs/operations.md` and the changelog.

### Fixed

- The demo seed prints the client origin its QR codes point at and refuses a localhost origin for a database that isn't local; seeded from a development machine, a deployed demo had codes nobody could scan.
- The four cart routes that answered their 404 as plain text (`removeItem`, `deleteItem`, `decreaseSplitItem`, `removeSplitItem`) now answer `{ message }` like every other error, so the front end can show the message.
- The public diner view of a cart no longer carries `paypalOrderId` or `paypalOrderIds` (Stripe's ids were already stripped).
- Two unreachable "Shops Not Found!" branches removed from the shop list routes.
- CORS refused the server's own origin, so Swagger UI's Try it out failed with a 500 on a dev server or on the API's host directly (through the front end's proxy it worked). A request whose Origin is the host it was sent to is allowed.
- Docs: the README said checkout is never rate limited; starting a card payment (`createStripeCheckout`) counts as a cart edit, capturing never does. The README's model listings named the menu model `MenuItem`; it is `Menu`.

## [2.0.0] - 2026-10-09

The rebuild of the 2021 API. Deploying it needs new environment variables, a Stripe webhook, and the back end deployed before the front end: see the README's Setup.

### Added

- Card payments through Stripe (Apple Pay and Google Pay included) beside PayPal, with manual capture: a card is authorised, the cart is re-checked, and only then charged. `createStripeCheckout`, `captureStripeCheckout`, and a webhook at `POST /payments/stripe/webhook`.
- One finisher per card payment (the diner's request, the webhook or a sweep every 2 minutes), so an authorised payment the diner abandons is still settled, and a `StripeCheckout` record that tells the diner the outcome on their next visit.
- Pay-backs (`Payback`): money Stripe won't return becomes a debt flagged on the table until a manager marks it done (`POST /shops/:shopId/paybacks/:paybackId/done`).
- Server-created PayPal checkout: `createCheckoutOrder` mints the order for the database-priced total, `captureCheckout` captures it after re-checking the cart and refunds automatically when a concurrent payer wins after capture.
- A payment record per settled payment (provider, ids, payer, lines at the prices paid), and an `Order` per payment as the sales record, rebuilt from the cart and kept when the cart, table or shop is deleted.
- Manager tools: table status (`GET /shops/:shopId/tables/status`), a table's carts with payments and the cart's manager log, release selections, remove items, close tables, merge duplicate carts, refund paid items with a reason, retry unclear refunds, check payments a provider holds as pending.
- Sold-out items: an unavailable or deleted item can't be added, claimed or paid for, and stays flagged in carts that hold it.
- `GET /shops/browse`, a paged shop list searched on the server.
- Rate limits per account: wrong passwords (10 in 15 minutes) and a diner's cart edits (120 a minute).
- Google sign-in links to an existing account by verified email. Email and password changes require the current password.
- Request validation with zod on every mutating endpoint, answering `400 { message: "Validation failed", details }`.
- An environment schema (zod) parsed at boot: a missing variable names every problem and exits.
- Indexes for every route's lookups, checked by a test that fails on any collection scan.
- An integration suite (Jest, Supertest, in-memory MongoDB, a fake Stripe that replays its races): 484 tests.
- Repair scripts: `syncOrders.ts`, `finishStripeCheckouts.ts`, `findDuplicateOpenCarts.ts`.

### Changed

- Express 5, Mongoose 9, TypeScript 6, dotenv 18, cloudinary v2, bcrypt 6. `npm audit` reports 0 findings.
- `BACKEND_URL` is now `PUBLIC_API_URL`, the address a browser reaches the API on (the front end's proxied `/api` prefix). There is no fallback.
- Access tokens last 15 minutes; refresh tokens rotate atomically, and one rotated by another tab in the last minute answers `401` with `reason: "superseded"` and leaves the cookies alone.
- Error responses are sanitised: `4xx` return `{ message, details? }`, everything else a generic `500`.
- Deleting a table keeps it under the shop's `deletedTables` so its carts and money stay reachable; deleting a shop takes its menu, carts and pay-backs, and is refused while money is still moving.
- A shop's phone is stored as typed. Menu prices must be whole pence.
- Image uploads check permissions first, accept images only up to 5 MB, and delete the replaced image.

### Removed

- The client-trust checkout endpoints (`checkOutSplit` and the payment-id flow): the client never reports a payment any more.
- `express-session`: Google OAuth runs through Passport with `session: false`.

### Fixed

- Mass assignment on register and profile edit (a user could set their own role).
- Refresh-token rotation, which never rotated; a Google user's login crash; cart quantity edge cases; a table rename that wiped its id and QR URL.
- Cart reads by other users; one shared open cart per table; carts left fully paid now close.

## [1.0.0] - 2025-03-08

The API as built for the 2021 capstone: users, shops, tables with QR URLs, menus, shared table carts with per-item splitting, PayPal checkout confirmed by the client, Cloudinary uploads, JWT cookies and Google OAuth.

[Unreleased]: https://github.com/Nando-C/UnQ-BE/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/Nando-C/UnQ-BE/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/Nando-C/UnQ-BE/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/Nando-C/UnQ-BE/releases/tag/v1.0.0
