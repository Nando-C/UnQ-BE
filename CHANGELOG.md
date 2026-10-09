# Changelog

All notable changes to the UnQ API. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

UnQ ships as two repositories that release together. A front-end release `x.y.*` needs this API at `x.y.0` or later; the shared MINOR says which pair belong together. Patches are independent. The MAJOR changes only when a release needs a change on the deployment host (new variables, a new webhook, a deploy order) or breaks a route the front end uses.

## [Unreleased]

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

[Unreleased]: https://github.com/Nando-C/UnQ-BE/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Nando-C/UnQ-BE/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/Nando-C/UnQ-BE/releases/tag/v1.0.0
