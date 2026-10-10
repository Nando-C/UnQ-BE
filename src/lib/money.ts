// Money as people read it, and in pence.

// The shop's currency: what every payment is made and compared in.
export const CURRENCY = "GBP"

export const money = (amount: number, currency: string = CURRENCY) =>
    new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount)

// In pence (or cents): for every amount sent to or compared with a provider in
// whole units. Prices add up in floating point (3 × £4.10 = 12.299999…), so a
// plain × 100 isn't a whole number, and two totals are compared this way.
export const toPence = (total: number) => Math.round(total * 100)
// Back to pounds, for the cart's money fields.
export const fromPence = (pence: number) => pence / 100
