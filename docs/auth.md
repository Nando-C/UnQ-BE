# Authentication and authorisation

Who the API believes a caller is, how that belief is kept alive and ended, and who may do what. Read from `src/services/auth/` (`tools.ts`, `middlewares.ts`, `controllers.ts`, `oauth.ts`), `src/services/users/`, `src/lib/passwordLimit.ts` and `src/settings/cors.ts`. The routes and their answers are in the [OpenAPI document](https://un-q.vercel.app/api/docs) under Auth and Users; [api.md](./api.md) has the conventions.

## Sessions are two cookies

A signed-in browser holds two `httpOnly; Secure; SameSite=None` cookies, set by register, login, Google sign-in and refresh, and never read by scripts:

| Cookie | Signed with | Lasts | Carries |
|---|---|---|---|
| `accessToken` | `JWT_SECRET` | 15 minutes | `{ _id, sid }`: the user and the session (device) |
| `refreshToken` | `JWT_REFRESH_SECRET` | 4 weeks | `{ _id, sid }` and a random `jti`, the id the session stores and rotation matches |

`SameSite=None; Secure` because in production the front end and the API are different sites (Vercel and Render), reached through the front end's `/api` proxy. Clearing a cookie needs the attributes it was set with, so setting and clearing share one options object.

Each sign-in is a **session of its own**, one per device, kept on the user document (`sessions[]`): the id (`jti`) of the refresh token the device holds now, the id of the one it held before its last rotation and when, the sign-in time, the last refresh, and the browser's User-Agent at sign-in (up to 200 characters). Never the token itself: a copy of the database can't sign in. Both tokens carry the session's id (`sid`), so every request knows which device it came from. An account holds **at most 10 sessions**; the eleventh sign-in drops the oldest, and any sign-in sweeps sessions that haven't refreshed in four weeks (their token has expired). Each is one atomic update, so two sign-ins at once on one account both land.

A sign-in on another device therefore changes nothing for this one. What ends a session: its own logout, a revocation (below), a password change (which ends every session but the one that changed it), being the oldest of eleven, or four weeks without a refresh.

### Refresh and rotation

`POST /auth/refreshToken` reads the `refreshToken` cookie (`400` without one) and:

- a valid token that is its session's current one is swapped for a new pair **atomically**: the store is a single `updateOne` conditioned on the session still holding the old token's id, so two tabs refreshing at once can't both win;
- the loser of that race, or any token its session replaced **in the last minute**, gets `401 { message: "Invalid token", reason: "superseded" }` and the cookies are left alone: the other tab's new cookies are in the browser already, and the front end resends with them. Only the device that rotated the token is told this; a token of a session that is gone is simply over;
- anything else (expired, malformed, signed with another key, replaced earlier, session gone, account gone) gets `401` **and both cookies cleared**: the session is over, and the next request is a guest's.

Database errors are a `500`, never a cleared session.

### Who the request is

Two middlewares read the access cookie (`auth/middlewares.ts`):

- `JWTAuthMiddleware`, on signed-in routes: no cookie → `401 "Please provide credentials in cookies!"`; an expired or bad token → `401 "Invalid token"` (the front end refreshes and retries); a valid token whose account is gone → `404 "User not found!"`.
- `optionalJWT`, on the public table cart: no cookie carries on as a guest; a valid one sets the user so they also see the notices meant for them; an expired or bad one is still a `401`, not the guest view, so a signed-in diner isn't quietly shown less. A failed refresh then clears the cookies, and the request after is a guest's.

### Ending a session

`GET /auth/logout` drops this device's session and clears both cookies (`204`); the account's other devices stay signed in. `GET /auth/sessions` lists the devices signed in, in sign-in order, with the caller's marked `current`, their sign-in and last-refresh times and their User-Agent, never the token ids; a device that hasn't refreshed in four weeks isn't listed. `DELETE /auth/sessions/:sessionId` signs one device out (`204`; `404 "Session not found"` for a session that isn't the account's): its next refresh fails, so it is a guest's within 15 minutes. Revoking the caller's own session clears the cookies too. Deleting the account (`DELETE /users/me`) clears them as well.

## Passwords

- Stored with bcrypt at `BCRYPT_ROUNDS` (10 to 13; 4 only inside Jest), hashed on save. A hash is never re-hashed at sign-in, so the cost of stored hashes doesn't rise with the setting.
- Emails are stored lowercase and trimmed, and looked up the same way, so capitalisation never matters.
- **Wrong passwords are limited per account**, not per address: `PASSWORD_FAILS_PER_ACCOUNT` (default 10) in a 15-minute window, wherever a password is compared (sign-in, and confirming the current password to change the email or password or to delete the account). Only real comparisons count: an email with no account, or a Google-only account, takes no room. A check is counted before it runs, so a burst of parallel guesses can't slip past, and a right answer gives its count back. Over the limit the account's password is unusable until the window ends (`429 "Too many wrong passwords for this account — try again in 15 minutes"`); a right password doesn't reset earlier wrong ones. Counts live in the process's memory.
- `POST /auth/login` answers `401 "Invalid credentials"` for a wrong password **and** for an unknown email or a Google-only account alike.

### Changing what guards the account

`PUT /users/me` needs `currentPassword` to change the email or set a new password (`400 "Enter your current password to change your email or password"`, `403 "Your current password is incorrect"`): a stolen access token alone can't take the account over. A wrong one is a `403`, not a `401`, so the front end doesn't go off to refresh the session. A new password issues fresh cookies to this device and ends every other session of the account. A Google-only account can't be given a password at all (`403 "This account signs in with Google, so it can't have a password"`): nothing could confirm it, so a stolen token could otherwise set one and keep the account for good. `DELETE /users/me` needs the current password for the same reason, and is refused while the user still owns a shop (`409 "Delete your shops first"`: hand it over or delete it) or is an administrator (`409 "An administrator's account is deleted by another administrator"`); a shop the user merely works at loses them.

What leaves the server about a user (`toJSON`): never the hash or the sessions; `hasPassword` says whether the account can sign in with a password, so the front end knows when to ask for the current one.

## Google sign-in

`GET /auth/googleLogin` redirects to Google (scopes `profile`, `email`; a navigation, not an XHR), and Google sends the browser back to `PUBLIC_API_URL/auth/googleRedirect`. That is why `PUBLIC_API_URL` is the address a **browser** reaches the API on, the front end's proxied prefix in production: the cookies set on the way back must land on an origin the front end's requests carry them to. Passport runs with `session: false`; there is no server session.

Which account a Google profile signs in (`googleUserFor`):

1. an account already linked by `googleId`;
2. else an account with the same email, **only if Google says the email is verified**: it's linked, and **its password is removed**, because nothing ever proved whoever set that password owned the address (anyone can register with someone else's email and wait). From then on only Google signs it in. Its avatar is taken from Google if it had none;
3. else, with a verified or unverified new email, a new account (surname optional: Google may not give one; the name falls back to the display name or the email's local part);
4. an unverified email that matches an account, or a profile with no email, signs nobody in: Passport's `failureRedirect` sends the browser to the front end's `/login` page rather than an error page.

On success the cookies are set and the browser is redirected to `FRONTEND_URL`, else `FRONTEND_DEV_URL`.

## Roles and ownership

Who may do what is decided in two places: the account's role, and the account's membership of a shop.

**Three account roles**, on the user: `customer` (the default), `shopMg` (may create shops for themselves) and `admin` (may do everything on every shop). **Neither of the last two comes from a request body**: register and profile edit take a fixed list of fields (mass assignment was a 1.0 bug), and both roles are set in the database. An administrator is never a member of a shop: the guards let them through everywhere instead.

**Membership** is on the shop: `shopMg` holds every member's id (what the guards read, indexed), and `members` holds one entry per id with a role, `owner` (exactly one per shop: the only member who deletes it) or `manager` (runs it), when they joined and, once something adds members, who added them. The two are only ever written together, in one update. A shop saved before membership existed has `shopMg` alone; the first time a member or an administrator opens it (any guarded route, or `GET /shops/me`), `membershipOf` sets `ownerId` to its first manager and `members` from the stored array, in one pipeline update conditioned on `ownerId` being absent, so two fills at once land once, nothing stale is written back, and a fill can never overwrite a later staff write. Public reads never fill. Until then, "owns a shop" is read in both shapes (`ownedBy` in the model): `ownerId`, or no `ownerId` and first in `shopMg`.

Four guards, always after `JWTAuthMiddleware`:

| Guard | Lets through | Otherwise |
|---|---|---|
| `canCreateShops` | the `shopMg` or `admin` role (creating a shop) | `403 "Shop Manager Only!!"` |
| `isShopManager` | any member of the shop in `:shopId`, or an administrator | `403 "Shop Manager Only!"`, or `404 "Shop Not Found!"` |
| `isShopOwner` | the owner of the shop in `:shopId`, or an administrator | `403 "Only the owner can do this"`, or `404 "Shop Not Found!"` |
| a cart's own checks | the cart must belong to the table in the URL, and a cart read by id only to a diner who started it or has a selection on it | `404 "Cart Not Found!"` |

The two shop guards set `req.shopRole` to how the caller got through (`admin`, or their member role), and the controllers behind them no longer filter on `shopMg` themselves: the guard is the one place that decides. `GET /shops/me` needs only a sign-in and answers the shops the caller is a member of (`[]` for none, every shop for an administrator). Creating a shop makes the caller its owner; an administrator names the owner (`ownerId`, any account but another administrator's: `404 "Owner not found"`, `409 "An administrator can't be a member of a shop"`), and from anyone else that field is `403 "Only an administrator names an owner"`.

The table's cart (`GET /carts/tables/:tableId`) is **public** by design: anyone at the table, signed in or not, sees the order. What the public view strips (payment and refund records, the manager log, the providers' ids, other diners' notices) is in [data-model.md](./data-model.md). Ordering, selecting and paying need a signed-in user, since payments and selections are theirs.

## CORS and the proxy

Browsers may call the API from the front end's origins (`FRONTEND_DEV_URL`, `FRONTEND_PROD_URL`) and from the API's own origin (Swagger UI at `/docs`), always with credentials. A request with no `Origin` header (curl, server to server, Stripe) is never a cross-site browser request and passes. Anything else is refused. The server sits behind one proxy (`trust proxy: 1`), so the own-origin check and client addresses read `X-Forwarded-*`.

Validation runs after authentication on every mutating route (`400 { message: "Validation failed", details }`), and the rate limit on cart edits after both; see [api.md](./api.md).
