# Payments

How money moves through UnQ: what a diner pays for, how the two providers are driven so nobody is charged for nothing, what happens when a payment is left half-finished, and how staff refund or pay a diner back. The routes themselves are in the [API reference](../README.md#api-reference); [api.md](./api.md) has the checkout table and the webhook's contract. This page is the reasoning behind them, read from `src/services/carts/controllers.ts`, `stripeCheckout.ts`, `stripeControllers.ts`, `stripeFinish.ts`, `stripeDeletion.ts`, `managerControllers.ts`, `src/services/payments/` and `src/lib/{payments,paypal,stripe,stripeWebhook}.ts`.

## What is paid for

A table has one open cart, shared by everyone sitting at it. A diner **selects** the units they will pay for (`addSplitItem`: their open *split*), and a checkout pays for exactly the caller's open selections, priced from the menu in the database, in GBP. Nothing the client sends is ever used as an amount: both providers are asked for the total the server computed, and the capture is verified against that total again, in pence, before anything is recorded.

Two providers, each in two calls around its own UI:

| | PayPal (`lib/paypal.ts`, Orders v2) | Card (`lib/stripe.ts`, Payment Element) |
|---|---|---|
| Step 1 | `createCheckoutOrder`: an order for the amount due, bound to cart and payer through `custom_id` (`"<cartId>:<userId>"`) | `createStripeCheckout`: a PaymentIntent with **manual capture**, cards only, plus a `StripeCheckout` record of it |
| The diner | approves the order in PayPal's popup | confirms the intent in the Payment Element: the card is authorised, not charged |
| Step 2 | `captureCheckout`: checks, then captures | `captureStripeCheckout`: checks, then captures or releases the hold |

Step 1 is a **reservation** with the provider, never a charge. Step 2 is the only place money moves, and it runs step 1's checks again first (`checkoutCheck`): the cart is the table's open cart, the caller has open selections, no selected unit is already paid or held by another diner's selection, nothing selected is sold out.

## Rules that hold everywhere

1. **Amounts come from the database.** `expectedTotalFor` sums the populated menu prices of the caller's open selections; a settlement in another currency or for another amount (compared in pence) is refused and refunded.
2. **A checkout id settles one checkout, ever.** Each settlement pushes the provider's id into the cart (`paypalOrderIds`, `stripePaymentIntentIds`), indexed unique across carts; a replay is refused before capture (`402 "This PayPal order has already been used"`), and checked again inside the settlement because the unique index can't see a duplicate within one cart's array.
3. **Settlement is version-checked.** `settleCheckout` reloads the cart for every attempt, re-derives the selections and the total, applies the payment in memory and saves under Mongoose's optimistic concurrency, up to 5 attempts. Two diners paying at once are serialised; no unit is paid twice.
4. **A lost race after capture is refunded, automatically.** When the settlement can't be saved (the units went to someone else, a replay, attempts exhausted, or a database error), the capture is refunded in full and the diner is told `409 "The table's cart changed while you were paying — your payment was refunded"` (or `"Your payment could not be recorded — your payment was refunded"`). A rejection never leaves someone charged for nothing.
5. **An unconfirmed payment holds its units.** A capture the provider is still reviewing (PayPal `PENDING`, Stripe `processing`) is recorded as a `pending` payment: its units count as paid, the cart stays open and the answer is `202`. Only a manager's check, or Stripe's webhook, settles it.
6. **Money and records never disagree on refunds.** A refund's record is saved as `pending` before the provider is asked, with the record's id as the provider's idempotency key; the record becomes `completed` or `failed` only from the provider's answer, and stays `pending` when that answer is unclear.
7. **For card payments, the cart is the truth for "paid"**, and **only the holder of a claim acts on an intent** (next section).

What is deliberately *not* re-checked: an item that sells out in the instant after a capture has been paid for and is not refunded for that.

## PayPal, step by step

`captureCheckout` (`controllers.ts`), in order:

| Check | Answer when it fails |
|---|---|
| (a) The order id is on no cart yet | `402 "This PayPal order has already been used"` |
| (b) `checkoutCheck` | `404 "Cart Not Found!"`, `404 "No open split items to pay!"`, `409 "Not enough unpaid units left to settle this checkout"`, `409 "A split item is no longer in the cart"`, `409` sold out |
| (c) The order is fetched: `APPROVED`, its `custom_id` is this cart and payer, GBP and exactly the amount due | `402 "Could not verify PayPal payment"`, `402 "PayPal order is not approved for capture"`, `402 "PayPal order was not created for this checkout"`, `409 "Your selection changed since the order was created, please retry"` |
| (d) Capture | `402 "PayPal capture failed"` (refused: nothing taken); `502 "We couldn't confirm your payment with PayPal — please contact staff before paying again (order …)"` when PayPal's answer doesn't say whether the buyer was charged; `402 "PayPal capture did not complete"` |
| (e) Settle (rule 3) | `200` with the cart, or `202` for a `PENDING` capture |
| (f) Settlement impossible: refund the capture | `409` with the "refunded" wording (rule 4); `500 "Payment captured but could not be settled or refunded — please contact staff (order …)"` if the refund fails too |

Step 1 (`createCheckoutOrder`) runs `checkoutCheck` **before** calling PayPal, so a doomed checkout never mints an order; a `502 "Could not create PayPal order"` means PayPal didn't answer. Neither PayPal call is rate limited: refusing a capture would leave an approved order unfinished.

## Card payments: one finisher

A card payment can be finished by three parties: the diner's own `captureStripeCheckout` call, Stripe's webhook (`payment_intent.amount_capturable_updated` once the card is authorised, then `succeeded`, `payment_failed`, `canceled`), and the server's **sweep** (every 2 minutes, `index.ts`). All three run the same procedure, `finishStripeIntent` in `stripeFinish.ts`, under two rules:

- **The cart is the truth for "paid".** An intent in some cart's `stripePaymentIntentIds` is recorded, whatever its record says, and a recorded intent is never refunded or cancelled by the procedure.
- **Only the claim holder acts.** The intent's `StripeCheckout` record carries a claim: a random token and a lease of 2 minutes (renewed before each Stripe call and each cart save). Every write a holder makes matches its token; a write that matches nothing means someone else took over, and the holder stops (`LostClaim`). A holder that stalls past its lease can be taken over.

### The record

`createStripeCheckout` writes the record right after Stripe creates the intent (if it can't, the intent is cancelled: no intent exists that the sweep can't see). It answers `{ clientSecret, paymentIntentId, amount }`, the amount in pence, so the front end confirms only the amount it showed. This route *is* rate limited with the cart edits (each call makes an intent, see [api.md](./api.md#rate-limits)); the capture isn't.

A record's `state`: `open` (nobody is finishing it) → `finishing` (claimed) or `releasing` (a holder decided to cancel it: whoever finishes it later only completes the cancel) → one of the final states `recorded` (on a cart), `released` (cancelled, nothing taken), `refunded` (captured, then refunded in full) or `refundFailed` (captured, and Stripe won't refund it: handed to staff). The record also remembers what the diner was answered and the stamps of the requests that answered it (`answered`, `answeredBy`), so an outcome they didn't read becomes a notice.

### The procedure

1. The diner's route acts only on an intent made for its cart, table and diner; otherwise `402 "This payment was not created for this checkout"`.
2. Already on a cart: the answer is that cart's payment's (`200` completed, `202` pending, `402 "This payment didn't go through: nothing was taken"` failed), and the record is synced to say so.
3. Claim the record (`open`, or a held one whose lease ran out). The route waits up to 8 seconds, polling every half second, for another finisher; when it's still held, the diner gets `502` with `reason: "STILL_CONFIRMING"` ("…please don't pay for these items again") and the webhook `200`.
4. Read the intent from Stripe and act on its status now: `requires_capture` → step 5; `succeeded`/`processing` → step 7; `canceled` → `released`; `requires_action` (the bank's check is still open) → back to `open`; a declined or never-confirmed one → released when the diner or the hour-mark sweep asks, otherwise back to `open`.
5. `checkoutCheck` again, and the authorised amount must equal the amount due in GBP; otherwise the intent is cancelled and the record `released` with the check's answer (`409 "Your selection changed since the order was created, please retry"`, or the check's own 404/409): nothing was charged.
6. Capture, under an idempotency key per claim. If the outcome is unclear, Stripe is asked where the intent stands; still unclear, the claim is given up at once so the next finisher takes over, and the diner hears "still confirming" (the webhook `500`, so Stripe retries). A capture Stripe refused is a release: `402 "Card payment capture failed — nothing was charged"`.
7. Captured: settle on the cart (rule 3, the lease renewed before each save). `200`, or `202` while Stripe is `processing`, and the payment's order is written. A settlement that errors is retried by later finishers for an hour from its first failure, then refunded, so a payment can't stay taken and unrecorded.
8. Settlement impossible: a **late refund** of what's left, under this claim's key, and the `409` "refunded" answer (rule 4). Stripe refusing it for a reason that won't clear (an expired, cancelled, lost or stolen card; a disputed charge; a charge Stripe can't refund; one the merchant cancelled) hands it to staff at once; any other refusal is retried every 30 minutes for a day, then handed over. A refund Stripe accepted and later reported failed (`refund.failed`) is made again up to 3 times, then handed over.

**Handed to staff** (`refundFailed`): a `refundRefused` pay-back is written for the table's shop (below), a `stripeRefundFailed` line goes on the cart's manager log with the diner's first name and the payment id, and the diner's answer or notice says to contact staff, or, when Stripe's reason is the diner's own dispute, that their bank returns the money.

### The diner who left

The route watches its response: if the connection closes before the reply is sent, the answer is taken back from the record (`takeBackAnswer`) so the diner gets it as a **notice** instead. Notices of card outcomes are built from the records when a cart is read (`paymentNotices`), only for records marked `confirmed` (the diner got past entering their card), only within 2 hours, at most the 5 newest with the cart's own notices, and only for outcomes the diner's own request didn't answer. Each outcome has its own notice id, so "being confirmed" then "went through" are two notices, and one the diner dismissed stays dismissed. A table with no open cart answers its `404` with those notices too.

Answers the diner can get, beyond the cart (`200`/`202`):

| Status | Meaning |
|---|---|
| `402` | Nothing was taken: refused, failed, cancelled, or not this checkout's intent |
| `404` with `reason: "CART_GONE"` / `"CART_GONE_PENDING"` | Recorded, but the cart was deleted since (with its table or shop); the money was taken |
| `409` "…your payment was refunded" | A lost race after capture (rule 4) |
| `500` "…please contact staff (payment …)" | Captured and not refundable yet, or handed to staff |
| `502` `reason: "STILL_CONFIRMING"` | The outcome can't be told yet: don't pay again; the cart updates, or a notice tells the outcome |

### The sweep

`sweepStripeCheckouts` runs every 2 minutes (one run at a time) and from `src/scripts/finishStripeCheckouts.ts`:

- claims whose holder stopped (a lease that ran out) are finished;
- `open` records at least 10 minutes old are looked at, without claiming them, every 10 minutes: finished if Stripe has them `requires_capture`, `succeeded`, `processing` or `canceled`, left alone otherwise (a sheet the diner may still be using), and **cancelled once an hour old** if still unauthorised;
- hand-overs whose staff weren't told yet are told;
- a record still unfinished two hours after it started is logged once.

## Pending payments

A payment the provider is still reviewing is `pending` (rule 5). While one is on a table, closing or merging its cart is refused (`409 "A payment on this table is still awaiting PayPal/Stripe: check it first"`) and the table is flagged `paymentPending`. A manager's `checkPayment` asks the provider (`checkProviderPayment`):

- **completed**: the payment is `completed`, the cart closes if everything on it is paid, the payer gets a note (PayPal) or their record's notice (card);
- **failed**: the payment is `failed`, its units are unpaid again and back in the payer's selection (`unsettle`), the cart reopens if it had closed, and the payer is told nothing was taken. A Stripe intent at `requires_payment_method` is cancelled first, so a sheet can't confirm a hold nobody would capture;
- **still pending**: `409 "… is still processing this payment. Check again later"`; the provider unreachable: `502`.

For card payments the webhook's `succeeded`/`payment_failed`/`canceled` run the same settlement with no manager (`checkPendingPayment`), so a pending card payment settles on its own.

## Refunds

Managers refund **lines of one payment**, at the prices that payment charged: `POST /shops/:shopId/carts/:cartId/refunds { paymentId, lines: [{ menuId, qty }], reason?, reasonNote? }`, on open and closed carts of the shop, with `reason` one of `unavailable`, `wrong_item`, `quality`, `long_wait`, `paid_by_mistake`, `changed_mind`, `other`. Refunded units are **cancelled**, not made payable again: they leave the cart's items and the payer's paid selection.

The order (rule 6):

1. The payment must be `completed` (`409` to check a pending one first, or that a failed one took nothing) and have a provider id for the money (`409 "This payment can only be refunded from …"` otherwise). Each line must be in the payment with units left: paid, less refunded, less refunds still pending (`400 "Only N× … of this payment can still be refunded"`, `400 "… has already been refunded"`, `400 "That item isn't in this payment"`).
2. A `pending` refund record is saved, version-checked (`409 "The cart changed, please retry"`). Pending units count as refunded, so a double click or two managers can't refund them twice.
3. The provider is asked (`lib/payments.ts` `refundPayment`), with the record's id as idempotency key and, for Stripe, as metadata that finds the refund again.
4. Refused: the record is `failed` with the reason, nothing moved, `502 "…. Nothing was refunded."`. Unclear (a timeout, a 5xx): it stays `pending`, `502 "… didn't confirm the refund …: retry it, which checks with … first."`. Made: the record is `completed`, the lines and units updated, the payer gets a note and the manager log a line, and the answer is `{ refund, cart }`. If that save fails after the provider refunded: `500` telling the manager to retry it, which records it.

`POST …/refunds/:refundId/retry` settles a pending refund: it first asks the provider whether it has a refund under that id (`findProviderRefund`) and records what it finds, completed or failed; only if the provider has none is it sent again under the same id, which the provider can't apply twice. Stripe's idempotency only lasts 24 hours, which is why the lookup is by metadata over every refund of the intent.

A refund Stripe accepts and later fails (`refund.failed`) is **not reversed** (decided 2026-10-07): see the webhook in [api.md](./api.md#stripes-webhook). The diner is owed it, so it becomes a pay-back.

## Pay-backs

Money staff must give a diner back another way, because Stripe won't (`src/services/payments/payback.ts`). Two kinds, each written once per payment or refund (a unique partial index makes a repeat a no-op):

- `refundRefused`: a late refund (procedure step 8) Stripe refused for good; `amount` is what's still taken.
- `refundFailed`: a manager's refund Stripe accepted, then failed; `amount` is the refund's and `paymentAmount` the whole payment's (a dispute is of all of it).

`disputed` means Stripe's reason was the diner's open dispute: their bank returns the money, staff don't pay it back. Pay-backs are kept apart from the cart, which may be closed and deleted before a hand-over, and are never shown to diners. A table's sheet shows its owed pay-backs and those done in the last 30 days; the table is flagged `payBack` while one is owed.

`POST /shops/:shopId/paybacks/:paybackId/done { as }` marks one done, `as` being what the sheet showed and the manager confirmed: `handled` (disputed), `checked` (a hand-over whose payment a cart now shows as paid: the diner wasn't charged twice) or `paidBack`. One that changed since the sheet showed it is refused (`409 "This pay-back changed: here it is again"`); one already done answers as it was marked. A `paybackDone` line goes on the cart's manager log, written without moving the cart's `updatedAt`.

### What a pay-back holds up

Deleting a shop waits (`stripeDeletion.ts`, `409` with the reason) while a card payment is still being finished or handed over and staff not told, while a diner is still to be paid back, and for **30 days after a card refund last moved**: a refund Stripe accepted can fail that long after, even after Stripe said it succeeded. Card payments with no refund, PayPal refunds, refunds that already failed and intents nobody confirmed don't hold it.

## Residual risks, accepted

- **A holder stalled past its lease** between renewing it and saving the cart can record a payment another holder has since decided to refund. The refund stands; the manager log gets one `stripeRefundedRecorded` line so staff know the diner wasn't charged, and a `refundRefused` pay-back for such a payment is marked `checked`, not paid back.
- **PayPal's capture answer can be unclear.** The diner is told to contact staff before paying again, with the order id; there is no PayPal webhook or sweep, so staff settle it from PayPal's dashboard.
- **A PayPal refund after a lost race can fail**: `500` with the order id for staff; it isn't retried.
- **Rate-limit counters live in the process** (see [api.md](./api.md#rate-limits)).

Known open bugs around payments are listed in [known-gaps.md](./known-gaps.md).
