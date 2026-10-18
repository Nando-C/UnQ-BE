# Data model

MongoDB through Mongoose 9, in seven collections. The cart is the live record of a table; the payment records on it, the card payment records (`StripeCheckout`), the orders and the pay-backs are the money's records, kept where deleting a cart, a table or a shop can't reach them.

This page is the companion to the response schemas in the API's [OpenAPI document](../src/openapi/components.ts) (browse them at `/docs`): what each collection is for, what the fields mean, and the rules the code keeps. Field lists are the Mongoose schemas as of this writing; the schema file named under each heading is the source of truth.

| Model | Collection | Schema | Timestamps |
|---|---|---|---|
| `User` | `users` | `src/services/users/model.ts` | yes |
| `Shop` | `shops` | `src/services/shops/model.ts` | yes |
| `Menu` | `menus` | `src/services/menus/model.ts` | yes |
| `Cart` | `carts` | `src/services/carts/model.ts` | yes, version-checked |
| `Order` | `orders` | `src/services/orders/model.ts` | no (`paidAt` dates it) |
| `StripeCheckout` | `stripecheckouts` | `src/services/carts/stripeCheckout.ts` | yes |
| `Payback` | `paybacks` | `src/services/payments/payback.ts` | no (`at`, `doneAt`), no `__v` |

## Conventions

- **Ids** are ObjectIds. A table has no collection of its own: it is an entry in its shop's `tables` array, and other records name it by that entry's `_id` (as a string in `tableId` fields). A `StripeCheckout`'s `_id` is Stripe's PaymentIntent id.
- **Money** is in pounds (GBP) to the penny: menu prices, cart `unitPrice`, payment and refund amounts, pay-backs and orders. The one field in pence is `StripeCheckout.amount`, as Stripe counts (and as `createStripeCheckout` answers it). Totals are compared in pence (`lib/money.ts`), never as floats.
- **Names from version 1** stay, because the front end reads them: `qtyPayed`, `Qr_Url`, `shopMg`, `web_URL`, `open_times`, `short_description`, and the cart status `splitted` (a legacy value nothing sets any more).
- **What leaves the server.** Each model's `toJSON` drops `__v`. `User` also drops `password` and `sessions` and adds `hasPassword`. `Cart`'s `toJSON` is the diner view (below); manager routes use `toObject()` instead. `Order` and `StripeCheckout` are served by no route.
- **Soft deletes.** A menu item taken off a menu is kept (`deletedFrom`); a deleted table moves to its shop's `deletedTables`; both go for good with their shop. A cart is deleted only when it is emptied with nothing worth keeping (no payment, refund or manager-log record).

## User

| Field | Type | Notes |
|---|---|---|
| `name` | string | required |
| `surname` | string | required unless the account has a `googleId` (Google may give no family name) |
| `email` | string | required, unique; stored trimmed and lowercased |
| `password` | string | bcrypt hash (`BCRYPT_ROUNDS`); absent on a Google-only account |
| `avatar` | string (URL) | generated initials image at register, or Google's |
| `role` | `customer` \| `shopMg` \| `admin` | default `customer` |
| `sessions` | array | the devices signed in, one per sign-in (below) |
| `googleId` | string | sparse index |

- `email` is matched however it is capitalised: the schema lowercases it on save, and lookups by email are cast the same way.
- `role: "shopMg"` (shop manager) can create shops for themselves; `role: "admin"` can do everything on every shop, and is never a member of one. Neither comes from a request body: register and profile edits take a fixed list of fields; both are set in the database. See [auth.md](./auth.md#roles-and-ownership).
- **Sessions.** One per device: `{ _id, jti, previousJti?, rotatedAt?, createdAt, lastUsedAt, userAgent? }`, the ids of the refresh token the device holds and of the one it held before its last rotation, never the tokens. Both tokens carry the session's `_id` as `sid`. At most 10 per account (the oldest sign-in goes); a sign-in drops the ones that haven't refreshed in four weeks. `auth/tools.ts` rotates a session's token atomically (`updateOne` matched on `sessions.jti`): of two tabs refreshing at once, one gets the new pair and the other is told `superseded`, and keeps its cookies. A logout, a revocation (`DELETE /auth/sessions/:sessionId`) or a password change removes sessions; the rest of the account's devices stay signed in.
- **Password checks** (sign-in, confirming the current password) count towards a per-account limit in `lib/passwordLimit.ts`: `PASSWORD_FAILS_PER_ACCOUNT` wrong ones in 15 minutes, then every check for that account is refused until the window ends. Counts live in the process's memory.
- Google sign-in links to an existing account only by a **verified** email, and removes that account's password (nothing proved whoever set it owned the address). See `auth/oauth.ts`.

Indexes: `email` unique; `googleId` sparse.

## Shop

| Field | Type | Notes |
|---|---|---|
| `name` | string | required |
| `cover` | string (URL) | default placeholder |
| `bio` | string |  |
| `open_times` | string |  |
| `phone` | string | as typed ("0161 496 0000"); older shops hold a number, read as text; "" clears it |
| `web_URL` | string |  |
| `timeZone` | string | an IANA name, `Europe/London` unless set: the zone the shop's days are counted in ([api.md](./api.md#sales-report)); shops from before it read as the default |
| `shopMg` | [ObjectId → User] | required: every member's id, the owner's included (what the guards read) |
| `ownerId` | ObjectId → User | the owner; absent on a shop no member has opened since membership arrived |
| `members[].userId` | ObjectId → User | required; one entry per id in `shopMg` |
| `members[].role` | `owner` \| `manager` | required; one `owner` per shop |
| `members[].since` | Date | required: when they joined |
| `members[].addedBy` | ObjectId → User | who added them; absent for a shop's first owner (nothing adds members yet) |
| `tables[]._id` | ObjectId | what every other record means by `tableId` |
| `tables[].name` | string | required; unique within the shop |
| `tables[].Qr_Url` | string (URL) | the table's page in the front end |
| `deletedTables[]._id` | ObjectId | the same id the table had |
| `deletedTables[].name` | string | required |
| `deletedTables[].deletedAt` | Date | required |
| `menu` | [ObjectId → Menu] | required |

- **Tables** are unique by name within a shop; the check is part of the create or rename update, so two requests at once can't both pass. `Qr_Url` is the table's page in the front end (`FRONTEND_ORIGIN/shops/:shopId/tables/:tableId`), set once at creation and kept through renames.
- **Deleting a table** moves it to `deletedTables` (same `_id`) rather than dropping it: it takes no orders and diners never see it, but its recent carts stay on the manager's page to be refunded. Refused while it has an open cart or a payment or refund awaiting its provider. `ofTable(tableId)` in the model finds the shop of a table current or deleted, for records from before carts recorded their shop.
- **Deleting a shop** takes its menu items (deleted ones too), its carts and its pay-backs, after writing any order they still owe. It waits for money in flight: an open cart, a pending payment or refund, a card payment still being finished, a diner to pay back, or a payment still refundable from a table's sheet (a paid cart closed or changed in the last 24 hours).
- **Membership.** `shopMg` and `members` are only ever written together, in one update. A shop from before membership (`shopMg` alone) is filled the first time a member or an administrator opens it: `membershipOf` sets `ownerId` to the first id and `members` from the stored array in one pipeline update, conditioned on `ownerId` being absent (two fills land once; nothing stale is written back; a fill never overwrites a staff write, which needs `ownerId` first). The demo seed writes both fields itself. `ownedBy(userId)` reads ownership in both shapes. See [auth.md](./auth.md#roles-and-ownership).
- Public responses leave `deletedTables` and `members` out (`ownerId` stays: an id, like the `shopMg` ids); the staff's own list (`GET /shops/me`) carries both, and marks each deleted table with `needsAttention` and `recentCartsUntil` (computed, not stored).

Indexes: `shopMg` (the same ids as `members.userId`, which has none of its own); `ownerId`; `tables._id`; `deletedTables._id`.

## Menu

| Field | Type | Notes |
|---|---|---|
| `name` | string | required |
| `image` | string (URL) | default placeholder |
| `short_description` | string | required |
| `description` | string |  |
| `price` | number | required; pounds to the penny (validated `multipleOf 0.01`) |
| `available` | boolean | default true; false: sold out |
| `category` | `food` \| `drinks` | required |
| `deletedFrom` | ObjectId → Shop | sparse index; set when taken off the menu |

- **Sold out** (`available: false`): the item can't be added to a cart, selected to pay for, or paid for; carts that hold it keep it, flagged, and the diner's bin removes it whoever selected it. The kitchen only acts on paid orders, so nothing is removed automatically.
- **Deleted** items are sold-out items with `deletedFrom` set: off the shop's `menu` array, kept so carts still name them. They are deleted for good with the shop. An item deleted before this rule existed is gone, and the cart's populate shows a stand-in named "No longer on the menu".
- Prices are whole pence because refunds price each line on their own: a fraction of a penny would make them add up to more than the checkout charged.

Indexes: `deletedFrom` sparse.

## Cart

The live record of a table. Each table has at most one **open** cart, shared by everyone sitting there: whoever orders first creates it, the others add to it. It closes once every unit is paid, or when a manager closes it; the next party then starts a new one.

| Field | Type | Notes |
|---|---|---|
| `userId` | ObjectId → User | required: who started the cart |
| `shopId` | ObjectId → Shop | absent on carts from before carts recorded it |
| `tableId` | string | required |
| `status` | `open` \| `splitted` \| `closed` | default `open`; `splitted` is legacy |
| `items[].menuId` | ObjectId → Menu | required |
| `items[].qty` | number | required: units ordered |
| `items[].qtyPayed` | number | default 0: units paid for |
| `split[].userId` | ObjectId | required: the diner |
| `split[].menuId` | ObjectId → Menu | required |
| `split[].qty` | number | required |
| `split[].splitStatus` | `open` \| `closed` | default `open`: selected to pay for; `closed`: paid |
| `split[].unitPrice` | number | set when paid: the price charged per unit |
| `split[].paidAt` | Date | set when paid |
| `split[].claimedAt` | Date | when first selected (not moved by later +/−) |
| `paypalOrderId` | string | legacy: the one PayPal order of a cart settled before multi-payer support; read, never written |
| `paypalOrderIds` | [string] | unique sparse: every PayPal order that settled part of this cart |
| `stripePaymentIntentIds` | [string] | unique sparse: every Stripe PaymentIntent that did |
| `payments[]` | Payment | manager-only; fields below |
| `refunds[]` | Refund | manager-only; fields below |
| `notices[].at` | Date | required |
| `notices[].forUserId` | ObjectId | present when the note is for one diner alone |
| `notices[].message` | string | required |
| `managerLog[].at` | Date | required; manager-only |
| `managerLog[].byUserId` | ObjectId | absent when the server itself wrote the line |
| `managerLog[].action` | string | required |
| `managerLog[].details` | string |  |

A **Payment** (`payments[]`), one per settled checkout, written in the same save that settles it:

| Field | Type | Notes |
|---|---|---|
| `provider` | `paypal` \| `stripe` | required |
| `status` | `completed` \| `pending` \| `failed` | default `completed`. `pending`: the provider took the money but hasn't confirmed it; its units are held, the cart stays open, and it can't be refunded until a manager's check. `failed`: a check said nothing was taken |
| `providerCheckoutId` | string | required: PayPal's order id, or Stripe's PaymentIntent id |
| `providerPaymentId` | string | PayPal's capture id, or Stripe's charge id: what a refund is made against. Missing only if the provider gave none |
| `currency` | string | required (GBP) |
| `userId` | ObjectId | required: the payer |
| `paidAt` | Date | required |
| `amount` | number | required: what was taken |
| `lines[].menuId`, `name`, `qty`, `unitPrice` | | required: each line at the price charged |
| `lines[].refundedQty` | number | default 0: units refunded since |
| `lines[].category` | string | the item's category when paid (absent on older lines) |

A **Refund** (`refunds[]`), a manager's refund of some units of one payment:

| Field | Type | Notes |
|---|---|---|
| `paymentId` | ObjectId | required: the payment's `_id` |
| `lines[].menuId`, `name`, `qty` | | required |
| `amount` | number | required |
| `currency` | string | required |
| `status` | `pending` \| `completed` \| `failed` | required. Written `pending` before the provider is asked; `completed` with `providerRefundId`; `failed` with `failureReason` |
| `providerRefundId` | string | |
| `failureReason` | string | |
| `byUserId` | ObjectId | required: the manager |
| `at` | Date | required |
| `reason` | `unavailable` \| `wrong_item` \| `quality` \| `long_wait` \| `paid_by_mistake` \| `changed_mind` \| `other` | for the sales report; absent on older refunds |
| `reasonNote` | string | with `other` only |

- **items** is what the table ordered, one line per menu item: `qty` ordered, `qtyPayed` paid for. **split** is who pays for what: a diner selects units of a line (an open split, `claimedAt` when first selected); checkout pays for all their open splits at once and closes them, stamping `unitPrice` and `paidAt`, so a later price edit doesn't change what the cart says was paid. Units in someone's open split are held for them: nobody else can select or remove them.
- **Availability is checked in the update's filter** (`fitsInItem` in `carts/controllers.ts`): the units every open split holds, plus the request, plus the paid units must fit in the line, checked and claimed in one atomic step, so two diners racing for the last unit can't both get it.
- **Optimistic concurrency.** The schema has `optimisticConcurrency: true`, so every `save()` is version-checked on any modified path, and a `pre` hook adds `$inc: { __v: 1 }` to every direct update, so an `addItem` can't let an older `save()` write over it. Checkout, the bin, refunds and the manager actions load, change and save; a save that meets a newer version retries or answers 409.
- **One open cart per table** is a unique partial index (`tableId_1`, `status: "open"`). Data from before it may hold duplicates: the manager's `mergeInto` folds the older into the newest, and `src/scripts/findDuplicateOpenCarts.ts` lists them when the startup index build fails.
- **Replay protection.** `paypalOrderIds` and `stripePaymentIntentIds` are unique sparse multikey indexes, so a provider id can settle one checkout across all carts. They default to `undefined`, not `[]`: an empty array is indexed as one key that a sparse index does not skip, so every unsettled cart would collide. The controller initialises the array before its first push.
- **Payments** are provider-neutral: only `provider` says whose ids the two `provider*` fields are, so another provider records into the same shape. A `pending` one holds its units as paid and keeps the cart open until a manager's check settles it.
- **Refunds** are written `pending` before the provider is asked (pending units count as refunded, so they can't be refunded twice), then completed or failed. One left `pending` means the provider was asked and the answer wasn't recorded: the manager's retry checks with the provider before sending it again under the same id.
- **Notices** are text for the table's diners about a manager's change, or a card payment's outcome. One with `forUserId` is for that diner alone. Diners see the last 2 hours, at most 5, newest first (`noticesFor`); once a cart is closed, only diners who took part in it (`tookPart`) see its table-wide notices.
- **The diner view** (`dinerView`, the model's `toJSON`) removes `__v`, `payments`, `refunds`, `managerLog` and the providers' ids (`paypalOrderId`, `paypalOrderIds`, `stripePaymentIntentIds`), and filters `notices` for the viewer. The table's cart is public (no sign-in), so payment records never leave the server this way. Manager routes use `toObject()` and populate diners by first name.
- Carts with money a provider hasn't confirmed (a pending payment, or a pending refund) are `AWAITING_PROVIDER`: only a manager can settle them, and they hold back deleting their table or shop.

Indexes: `{tableId, status, updatedAt}` (a table's recent closed carts); `{payments.status, tableId}` and `{refunds.status, tableId}` partial on `pending`; `{userId}` partial on `status: open`; `{shopId, status, updatedAt}`; `{paypalOrderId: -1}` partial on exists (legacy replay check); `{tableId}` unique partial on `status: open`; `paypalOrderIds` and `stripePaymentIntentIds` unique sparse. `src/tests/indexes.test.ts` fails on a collection scan in the main routes.

## Order

One per cart payment: the sales record, built from the cart by `syncOrder` (`services/orders/sync.ts`) after every save that changes the payment or a refund of it, and kept when the cart, table, menu items or shop are deleted. The sales report (`GET /shops/:shopId/sales`, [api.md](./api.md#sales-report)) reads it; nothing else does.

| Field | Type | Notes |
|---|---|---|
| `paymentId` | ObjectId | required, unique: the cart payment's `_id` |
| `cartId` | ObjectId | required: a table visit is the orders sharing it |
| `cartOpenedAt` | Date | required |
| `cartVersion` | number | required: the cart's `__v` it was built from |
| `shopId` | ObjectId | required |
| `tableId` | string | required |
| `tableName` | string | as it was when first written |
| `payerId` | ObjectId | required: counted, never shown |
| `status` | `completed` \| `pending` \| `failed` | required: the payment's |
| `paidAt` | Date | required |
| `currency` | string | required |
| `amount` | number | required |
| `provider` | `paypal` \| `stripe` | required |
| `providerCheckoutId` | string | required |
| `providerPaymentId` | string |  |
| `lines[].menuId`, `name`, `unitPrice`, `qty`, `refundedQty` |  | required |
| `lines[].category` | string \| null | when paid; null if unknown |
| `refunds[].refundId` | ObjectId | required: the cart refund's `_id` |
| `refunds[].status`, `at`, `amount`, `lines[]` |  | required; `lines[]` as the cart refund's |
| `refunds[].reason`, `reasonNote` |  | as the cart refund's |

- The cart stays the source of truth; an order is never edited by hand. `cartVersion` keeps an older copy of the cart from overwriting a newer order. The unique `paymentId` index is created and awaited before the server listens (`src/index.ts`), so a repeated sync can never double an order.
- A sync that fails after the money moved is logged ("Order not written") and never fails the request: `npx tsx src/scripts/syncOrders.ts` writes or repairs every order; `deleteMyShop` runs the same repair before deleting a shop's carts.
- A refund counts on the day it was made (`refunds[].at`), not the day of the payment.

Indexes: `paymentId` unique; `{shopId, paidAt}` (the report's orders); `{shopId, refunds.at}` (its refunds, by their own day); `{shopId, payerId, paidAt}` (returning diners: who had paid before the range).

## StripeCheckout

One per Stripe PaymentIntent the API created, written right after Stripe creates it, so every intent has a record the server's sweep can find. It says who is finishing the payment (the diner's capture request, the webhook or the 2-minute sweep, one at a time) and how it ended, and it carries the outcome the diner is told when their own request didn't answer it. Kept as an audit trail; diners never see it directly.

| Field | Type | Notes |
|---|---|---|
| `_id` | string | the PaymentIntent id |
| `cartId`, `tableId`, `userId` |  | required: who it was made for |
| `shopId` | ObjectId | the table's shop when created (older records: found by the table) |
| `amount` | number | required; **in pence**, as created |
| `state` | `open` \| `finishing` \| `releasing` \| `recorded` \| `released` \| `refunded` \| `refundFailed` | default `open` (states, below) |
| `token`, `leaseUntil` | string, Date | the current holder's claim |
| `checkedAt`, `reportedAt` | Date | the sweep's bookkeeping on an open record |
| `confirmed` | boolean | default false: the diner got past entering their card (only then do they get a notice) |
| `finishedAt` | Date | when it reached a final state, or its payment's status last changed |
| `paymentStatus` | `completed` \| `pending` \| `failed` | the payment's (`recorded` only) |
| `answered`, `answeredBy` | string, [string] | the outcome the diner's own request gave them, and which requests gave it |
| `status`, `message` | number, string | the answer given for a released or refunded intent |
| `refunding` | boolean | a holder decided to refund it: later ones only complete the refund |
| `refundId`, `refundFailures`, `refundRefusedSince`, `refundRetryAt` |  | the late refund's bookkeeping (time windows, below) |
| `staffToldAt`, `refundOwed`, `disputed` | Date, number (pence), boolean | a `refundFailed` one: when staff were told, what's still taken, whether the diner's dispute pays them back |
| `settleFailingSince` | Date | when saving its captured payment first failed |

- **States.** `open` (nobody is finishing it) → `finishing` (claimed) or `releasing` (a holder decided to cancel it; whoever finishes it later only completes the cancel) → `recorded` (on a cart), `released` (cancelled, nothing taken) or `refunded` (captured, then refunded in full because it couldn't be recorded). One whose refund Stripe won't make is `refundFailed`: handed to staff as a pay-back.
- **Claims.** A finisher claims the record with a fresh token and lease; every write it makes matches its token, and a lease that ran out can be taken over. A diner's request waits a little for another finisher before answering "still confirming".
- **Notices.** A final, confirmed record whose outcome isn't the one `answered` is shown to the diner as a notice (`paymentNotices`), built when read: a later outcome of the same payment (pending, then completed or failed) is shown even after the earlier one was dismissed.
- A record is synced from its cart's payment status (`syncRecordFromCart`) whenever the payment is checked, so a record left behind by a crash between the cart's save and its own is repaired.

Indexes: `{state, createdAt}`; `{shopId, updatedAt}` and `{tableId, updatedAt}` partial on `refunding: true`; `{userId, tableId, finishedAt}` partial on `finishedAt` exists.

## Payback

Money staff must give a diner back another way, because Stripe won't: one per card payment handed to staff (`refundRefused`: the API's own refund of a payment it couldn't record failed for good) and one per manager's card refund that Stripe accepted and then failed (`refundFailed`). Kept apart from the cart, which may be closed and deleted before a hand-over. Shown on the table's sheet (owed, and done in the last 30 days), flagged on the table until a manager marks it done; the shop can't be deleted while one is owed. Diners never see it.

| Field | Type | Notes |
|---|---|---|
| `shopId`, `tableId`, `cartId` |  | required: where it was owed (the cart may be gone) |
| `kind` | `refundRefused` \| `refundFailed` | required |
| `userId` | ObjectId → User | required: the diner to pay back |
| `amount` | number | required: owed, in pounds |
| `currency` | string | required |
| `paymentIntentId` | string | Stripe's payment, to find it in the dashboard |
| `refundId` | ObjectId | the cart's refund record (`refundFailed`) |
| `paymentAmount` | number | the whole payment's (`refundFailed`; a dispute is of all of it) |
| `disputed` | boolean | the diner disputes the payment with their bank, which returns it; staff don't |
| `owed` | boolean | true until done, then unset (what the indexes and queries use) |
| `at` | Date | required |
| `doneAt`, `doneByUserId` | Date, ObjectId → User | who marked it done, when |
| `doneAs` | `paidBack` \| `handled` \| `checked` |  |

- Written once per cause: the unique partial indexes on `paymentIntentId` (for `refundRefused`) and `refundId` (for `refundFailed`) make a repeat (Stripe's event again, the sweep, a retry) a no-op.
- Marking one done needs `as` to match what the sheet showed (`paidBack`; `handled` for a dispute; `checked` for a hand-over whose payment a cart now shows as paid), so what's stored is what the manager confirmed. The cart gets a `paybackDone` log line written without touching its `updatedAt`.

Indexes: `paymentIntentId` unique partial on `kind: refundRefused`; `refundId` unique partial on `kind: refundFailed`; `shopId`; `{tableId, owed}` partial on `owed: true`; `{tableId, doneAt}` partial on `doneAt` exists.

## Time windows the code keeps

| Window | Where | Value |
|---|---|---|
| A closed cart stays on its table's sheet (refundable) | `RECENTLY_CLOSED_MS` | 24 hours |
| Diners see notices | `NOTICE_MAX_AGE_MS`, `NOTICE_MAX` | 2 hours, 5 newest |
| A selection counts as stale for the manager | `STALE_SELECTION_MS` | 15 minutes |
| Done pay-backs shown on the sheet | `PAYBACKS_DONE_SHOWN_MS` | 30 days |
| Access token / refresh token | `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL` | 15 minutes / 4 weeks |
| Another tab's refresh counts as a race | `RACE_WINDOW_SECONDS` | 60 seconds |
| Wrong-password window | `lib/passwordLimit.ts` | 15 minutes |
| The card payment sweep | `src/index.ts` | every 2 minutes |
| A card payment finisher's claim (lease) | `stripeTiming.leaseMs` | 2 minutes |
| The diner's capture request waits for another finisher | `stripeTiming.waitMs` | 8 seconds, then "still confirming" |
| A captured card payment that can't be saved is retried | `SETTLE_RETRY_MS` | 1 hour, then refunded |
| A late card refund Stripe refused is retried | `REFUND_RETRY_MS`, `REFUSED_FOR_MS` | every 30 minutes, for 24 hours, then handed to staff |
| A late card refund Stripe failed is made again | `REFUND_REOPENS` | 3 times, then handed to staff |
