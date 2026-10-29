# Operations

Running, deploying and repairing the API. Read from `src/index.ts`, `src/server.ts`, `src/settings/env.ts`, `src/scripts/`, `.github/workflows/` and the [changelog](../CHANGELOG.md). Variables are named here, never valued: `.env` holds real secrets.

## How the server starts

`src/index.ts`, in order: load `.env`, **validate the whole configuration** (`settings/env.ts`: every problem is printed at once, names only, and the process exits non-zero), import the app, print the route table, connect to MongoDB, start every model's index build, **await the orders' unique payment index** (so no order can be written before it exists) and listen. Then it logs the port, the PayPal mode (`SANDBOX`/`LIVE`, from `PAYPAL_API_BASE`) and the Stripe mode (`TEST`/`LIVE`, from the key's prefix): check both lines on a deploy before taking real payments. A typo in `PAYPAL_API_BASE` is the one misconfiguration the schema can't catch (the default applies), which is what that log line is for.

An index that can't be built is logged with a hint, not fatal: duplicates on the one-open-cart-per-table index (list them with `findDuplicateOpenCarts.ts`), or an existing index with the same name or keys and other options (compare `getIndexes()` with the schema before changing either; some are unique guards, never drop one to make room).

A sweep of unfinished card payments runs every 2 minutes (see [payments.md](./payments.md#the-sweep)).

## Configuration

The variables, with what they are for, are in the README's [Environment Variables](../README.md#environment-variables) table; a test keeps that table and `.env.example` equal to the schema's keys. The ones that catch people out:

- **`PUBLIC_API_URL` is where a browser reaches the API**, not the server's own host. In production that is the front end's proxied prefix (`https://un-q.vercel.app/api`): Google's OAuth callback is built from it, and the cookies it sets must land where the front end's requests carry them.
- **`FRONTEND_URL`** (else `FRONTEND_DEV_URL`) is where Google sign-in redirects back to and what table QR codes point at; **`FRONTEND_DEV_URL` + `FRONTEND_PROD_URL`** are the CORS whitelist. At least one of each pair.
- **`STRIPE_WEBHOOK_SECRET`** must exist before the API deploys: the server won't start without it, so the webhook endpoint is created in Stripe's dashboard first.
- **`BCRYPT_ROUNDS`** below 10 is refused outside Jest.
- Rate limits (`PASSWORD_FAILS_PER_ACCOUNT`, `CART_EDITS_PER_MINUTE`, `PEOPLE_ADDED_PER_HOUR`) count in the process's memory: they reset with a restart and aren't shared between instances.

### The first administrator

Roles never come from the account's own request: the `shopMg` and `admin` roles are given by an administrator (`POST /users`, `PUT /users/:userId/role`), and the first administrator is set in the database, on an account that is on no shop (an administrator is never a member; hand over or leave first, through the app):

```js
db.users.updateOne({ email: "you@example.com" }, { $set: { role: "admin" } })
```

The same line is the way back if no administrator is left (an administrator never acts on their own account, so only two acting on each other in the same instant can manage it: [known-gaps.md](./known-gaps.md#accepted-residuals)). The demo seed never creates an administrator and never touches an account outside its own addresses, which it rewrites by email whoever created them (`manager@mail.com`, `frank@mail.com`, `alex.demo@example.com`, the `@example.com` diners), so an administrator on any other address survives every nightly reseed.

## Where it runs

| Piece | Host | Notes |
|---|---|---|
| API | Render, `https://unq-be.onrender.com` | Node 20.19+ (`engines`), `npm run build` then `npm start`; one instance, one proxy hop (`trust proxy: 1`); a free instance sleeps, so the first request after a while is slow |
| Front end | Vercel, `https://un-q.vercel.app` | Rewrites `/api/*` to the API, so the browser sees one origin; Swagger UI is at `/api/docs` |
| Database | MongoDB Atlas | **MongoDB 5.0 or later**: the shop search uses `$lookup` with `localField` and a `pipeline`; the test suite runs on a local `mongod` |
| Images | Cloudinary | configured by `CLOUDINARY_URL` alone |
| Payments | PayPal (Orders v2), Stripe (PaymentIntents, manual capture) | sandbox / test mode; going live is a separate step (below) |

### Cutting a release

UnQ releases as a pair: the API at `x.y.0` first, then the front end at `x.y.*` (the rule is at the top of the [changelog](../CHANGELOG.md)). A release goes out on a branch `release/x.y.0` that one pull request merges:

1. **Settle the docs.** Every claim in `README.md`, `docs/` and the OpenAPI document that changed since the last tag is re-read against the code (`git diff $(git describe --tags --abbrev=0)..main --stat -- README.md docs/ src/openapi/` lists the pages), and [known-gaps.md](./known-gaps.md) says what the release still leaves open, its roadmap paragraph included. The front end's README and the product page describe the live demo: a flow that changed changes their sentences too.
2. **Close the changelog.** The Unreleased section becomes `[x.y.0] - <date>`, opened by a paragraph that says what changed, what the host needs (usually nothing) and which front-end release pairs with it; an empty Unreleased section goes above it.
3. **Bump the version**: `npm version minor --no-git-tag-version` (or `patch`), and the README's version badge to match; a test fails when they differ.
4. **Run the gates** (below), open the pull request, and merge once CI agrees. Render deploys `main`: read the boot log, and `GET /health` must answer the new version.
5. **Tag what is deployed**, `git tag -a vx.y.0 -m "UnQ API x.y.0"` on `main`, and push the tag.
6. **Release the front end** by its own list ([deployment.md](https://github.com/Nando-C/UnQ-FE/blob/main/docs/deployment.md#releasing)), then close the roadmap issues the pair ships, each with a line on what shipped where.

### When the host changes

A MAJOR means the host needs a change; read the changelog's deploy notes for it. The order that worked for 2.0.0:

1. **Stripe's dashboard, test mode first**: add the webhook endpoint `https://unq-be.onrender.com/payments/stripe/webhook` with the events `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `refund.failed`; copy its signing secret. Register the front end's domain under Payment method domains, or the card form never offers Apple Pay or Google Pay (each subdomain separately; preview URLs and `localhost` aren't covered).
2. **Set the host's variables** on Render: everything in the README's table that is required, the Stripe pair among them.
3. **Deploy the API**, then read the boot log: the route table, the PayPal and Stripe modes, no index warning.
4. **Deploy the front end** with its publishable key and `/api` rewrite.
5. **Check it**: `GET /health` answers `{ status: "ok", version, uptime }` with the version just released; `/api/docs` opens through the front end's proxy and Try it out works; a test card (`4242 4242 4242 4242`) pays, `4000 0025 0000 3155` asks for the bank's check, `4000 0000 0000 0002` is declined; close a tab after authorising and see the webhook or the sweep finish it, and the notice appear when the table is reopened.

```bash
curl -s https://unq-be.onrender.com/health
node src/scripts/validateOpenApi.mjs https://unq-be.onrender.com/openapi.json
```

Going live is a deliberate step of its own, not part of a release: live PayPal and Stripe keys and the live webhook on the host, after which the boot log must say `LIVE` for both.

## Local development

```bash
cp .env.example .env     # fill in the names; sandbox and test keys
npm install
npm run dev              # tsx watch, port 3001
stripe listen --events payment_intent.amount_capturable_updated,payment_intent.succeeded,payment_intent.payment_failed,payment_intent.canceled,refund.failed --forward-to localhost:3001/payments/stripe/webhook
```

The Stripe CLI's signing secret (`stripe listen --print-secret`) is `STRIPE_WEBHOOK_SECRET` locally; it is stable per machine and account. Swagger UI is at `http://localhost:3001/docs`; Google sign-in needs the front end running on the origin `PUBLIC_API_URL` and `FRONTEND_DEV_URL` point at.

## Gates and CI

Every change passes, run separately with their exit codes read:

```bash
npx tsc --noEmit
npm run lint
npm test          # Jest, in band; in-memory MongoDB, providers mocked, no secrets needed
npm run build
```

CI (`.github/workflows/ci.yml`) runs the same four on Node 24 for every push to `main` and every pull request, from `npm ci`. A second workflow, Docs (`.github/workflows/docs.yml`), fails a pull request that changes `src/` (the tests apart) or the nightly reseed workflow without touching `CHANGELOG.md`, `README.md` or `docs/`: a rule that moved while the page describing it didn't is the slip no test can catch. The `no-docs` label says the change is invisible to anyone using or running the API, and the check stands down; it reads the pull request's file list, so it needs no checkout. The pull request template lists what a change carries with it (a changelog entry, the page a changed rule lives on, the OpenAPI operation, the issue it closes), and the issue templates ask which page describes the behaviour. **After any `npm install` or `uninstall`, run `npm ci --dry-run --os linux --cpu x64`** and check the exit code: on macOS npm skips the Linux-only optional packages and used to drop their peers (`@emnapi/core`, `@emnapi/runtime`) from the lockfile, which failed CI twice; both are pinned as devDependencies so the lockfile always holds them.

`package.json`'s `overrides` gives Jest's coverage tooling `js-yaml` 4, for an advisory in `sprintf-js` that has no fixed version; remove it once `@istanbuljs/load-nyc-config` itself depends on js-yaml 4 (`npm ls js-yaml` shows).

## Repair scripts

All read `MONGO_CONNECTION` from `.env` (never printed), run with `npx tsx`, and are safe to run beside the server:

| Script | When |
|---|---|
| `src/scripts/finishStripeCheckouts.ts` | A card payment looks stuck, or the server was down: the sweep's work, once, printing what it did |
| `src/scripts/syncOrders.ts` | The server logged "Order not written": rebuilds every payment's order from its cart (idempotent; also the backfill when orders first shipped) |
| `src/scripts/findDuplicateOpenCarts.ts` | Startup warned that the one-open-cart index can't be built: lists tables with more than one open cart, newest first (read-only; resolving each is a decision per table, keeping paid units) |
| `npm run seed:demo` (`src/scripts/seedDemo.ts`) | Setting up a demo or a fresh development database: writes the demo data (below) and rewrites only what it owns on a rerun |
| `src/scripts/validateOpenApi.mjs [url \| file \| -]` | After a change to `src/openapi/`: validates the document (exit 0 valid, 1 invalid, 2 unreadable) |

## The demo data

`npm run seed:demo` writes a reproducible demo (`src/scripts/demo.ts`): three shops with menus and tables (a café, a restaurant, a Saturday pop-up; a sold-out and a deleted item each), a manager who owns all three, the café's staff (a second manager, `alex.demo@example.com`, added by the first; a till, `kim.demo@example.com`, added by the first too; a kitchen, `jo.demo@example.com`, added by the second manager; none with a sign-in, so the staff list shows the roles and nobody new can sign in) and forty diners, and 90 days of closed carts with payments from both providers, splits by several diners, refunds with reasons, one refund that failed, and the live states a manager's page shows: a table being ordered at, a selection held over 15 minutes, a sold-out item in a cart, a PayPal payment held for review, a diner to pay back after Stripe refused a refund, a pay-back marked done, and a table deleted with a cart refunded since; these sit at the latest moment the shop was open (now while it is, else the last hour of its last open day), so a seed run at night writes no order outside the shop's hours. Every payment's order is written through the real sync. The history is shaped for the sales report: visits start mostly in each shop's busy spells (a morning and a lunch at the café, lunch and dinner at the restaurant), come mostly from a dozen regulars with the rest from diners seen once or twice, each making a first visit at one of the shops, spaced over the ninety days on days the shop opens, so every shop sees a new face in any month and on its latest open days, include a pastry launched in week six, and weight refund causes the way a kitchen's are (long waits on busy Friday and Saturday evenings). Each shop tells one story, so that the figures on My Shops and the Sales tab read the same way whatever day the seed runs: the café is doing well, nearly twice as busy at the end of its ninety days as at the start, with one bad week five weeks back (half the visits, three times the refunds) for the charts to show and its best week the one just gone, so its week and its month both read up; the restaurant is struggling, half as busy as it was and with its worst week the one just gone, so both read down; the pop-up opened less than three weeks ago and is growing fast, so its week (one Saturday against the one before) reads up and its month reads as new, with no month before it. Random draws still move a week's figure by a few per cent either way; the stories are strong enough to read through them on any day. Because the history ends yesterday, a card's **Net sales today** shows only the live states' payments, and the Sales tab's today is nearly empty, until the day's visitors order. Days and hours are the shops' own (`Europe/London`), whatever clock the seed runs on. Every id, quantity and date comes from seeded generators (one main sequence, and one of its own for the café's till and kitchen, so adding them moved no earlier id or date) and the current hour, so a rerun in the same hour writes the same documents; the demo shop and its QR table keep the ids the front end's README has carried since 2021.

The tables' QR codes point at `FRONTEND_URL` (else `FRONTEND_DEV_URL`), so seeding a deployed database from a development machine needs it set to the live client (`FRONTEND_URL=https://un-q.vercel.app npm run seed:demo`); the seed prints the origin it used and refuses a localhost one for a database that isn't local. It needs `DEMO_MANAGER_PASSWORD` and `DEMO_DINER_PASSWORD` in `.env` (the two sign-ins, `manager@mail.com` and `frank@mail.com`; found by email, so existing accounts keep their id and sessions, and a password is rehashed only when it changes) and refuses to run without them. It deletes and rewrites only the demo shops' records, by their fixed ids, their carts, orders, card payment records and pay-backs, and the menu items it created; nothing else in the database is touched. The provider ids it writes are marked (`pi_demo_…`, `DEMO…`), so the held PayPal payment answers "unreachable" to a manager's check and the owed pay-back can't be looked up in Stripe: they are there to be seen, not settled. `src/tests/seedDemo.test.ts` runs it twice against the in-memory database and reads the result back through the manager's routes.

The deployed demo is reseeded every night by `.github/workflows/demo.yml`: at 03:30 UTC (03:30 or 04:30 in London, hours before the first shop opens), and on demand from the repository's Actions tab, it runs `npm run seed:demo` on a GitHub runner from three repository secrets, `MONGO_CONNECTION`, `DEMO_MANAGER_PASSWORD` and `DEMO_DINER_PASSWORD`, with the QR codes pointing at the live client and placeholders for the variables the seed never reads. So the demo's ninety days end yesterday whatever the date, and whatever visitors did at its venues is gone by morning, staff added to them included (accounts visitors created or were given stay: the seed touches only its own records). The database's network access must admit GitHub's runners, whose addresses change. One run at a time: a manual run during the nightly one waits for it. GitHub pauses a schedule after sixty days without a commit to the repository; the Actions tab says so, and re-enables it.

## What to look at when something is wrong

- **A 500 with "Generic Server Error"**: the real error is in the server log (`errorsHandler` prints it); a 5xx written for the user carries its message instead.
- **A card payment the diner says was taken**: find its intent id in the message or notice (`payment pi_…`), then its `StripeCheckout` record (`state`, `status`, `message`, `refundFailures`) and whether a cart lists it in `stripePaymentIntentIds`. The cart is the truth for "paid". Stripe's dashboard shows the charge and its refunds.
- **"still unfinished two hours after it started"** in the log: the sweep keeps trying that record; look at the intent in Stripe's dashboard and the record's `state`.
- **A pay-back on a table's sheet**: money Stripe won't return; staff pay it back another way and mark it done (see [payments.md](./payments.md#pay-backs)).
- **CORS "Not Allowed By Cors!"**: the Origin isn't a front-end origin or the API's own; check `FRONTEND_DEV_URL`/`FRONTEND_PROD_URL` on the host.
- **Google sign-in lands on an error or the cookies don't stick**: `PUBLIC_API_URL` isn't the origin the browser is on; the callback must be the proxied prefix.
