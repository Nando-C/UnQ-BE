import env from "../settings/env"

const WINDOW_MS = 15 * 60 * 1000
export const TOO_MANY_WRONG_PASSWORDS = "Too many wrong passwords for this account — try again in 15 minutes"

// Password guessing: wrong passwords per account (by id), wherever they're
// tried: signing in, and confirming the current password to change the email
// or password or to delete the account. Per account, not per IP (see
// middlewares/rateLimits.ts). Only real comparisons count, so an email with no
// account, or one with no password, takes no room here.
// A check counts from the start, so a burst of parallel guesses can't get past
// the limit; a right one or a failed one (a fault) then gives its count back, to
// the window it took it from. Once over, the account can't use its password
// until the window ends; a right password doesn't clear earlier wrong ones.
// Counts live in this process's memory: they restart with it.
const tries = new Map<string, { count: number; resetAt: number }>()

// `compare` unless the account is over its limit: whether the password was
// right, or "locked".
export const limitedPasswordCheck = async (accountId: string, compare: () => Promise<boolean>) => {
    const now = Date.now()
    let window = tries.get(accountId)
    if (!window || window.resetAt <= now) {
        window = { count: 0, resetAt: now + WINDOW_MS }
        tries.set(accountId, window)
    }
    if (window.count >= env.PASSWORD_FAILS_PER_ACCOUNT) return "locked" as const
    window.count++
    let wrong = false
    try {
        wrong = !(await compare())
        return !wrong
    } finally {
        if (!wrong) window.count--
    }
}

// How many accounts have a window open (what this costs in memory).
export const accountsCounted = () => tries.size

// Ended windows are dropped every minute, so only current ones stay.
setInterval(() => {
    const now = Date.now()
    for (const [accountId, window] of tries) if (window.resetAt <= now) tries.delete(accountId)
}, 60 * 1000).unref()
