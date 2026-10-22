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

**Three account roles**, on the user: `customer` (the default), `shopMg` (may create shops for themselves) and `admin` (may do everything on every shop, and manage accounts). **Neither of the last two comes from the account's own request**: register and profile edit take a fixed list of fields (mass assignment was a 1.0 bug); an administrator gives them (`POST /users`, `PUT /users/:userId/role`), and the first administrator is set in the database ([operations.md](./operations.md#the-first-administrator)). An administrator is never a member of a shop: the guards let them through everywhere instead.

**Membership** is on the shop: `shopMg` holds every member's id (what the guards read, indexed), and `members` holds one entry per id with a role (`owner`, exactly one per shop; `manager`; and below manager `till`, `floor` and `kitchen`, see [What each role may do](#what-each-role-may-do)), when they joined and who added them (absent for the first owner of a shop they created themselves (an administrator who creates the shop for them is recorded) and for the members of a shop from before membership). The two are only ever written together, in one update. A shop saved before membership existed has `shopMg` alone; the first time a member or an administrator opens it (any guarded route, or `GET /shops/me`), `membershipOf` sets `ownerId` to its first manager and `members` from the stored array, in one pipeline update conditioned on `ownerId` being absent, so two fills at once land once, nothing stale is written back, and a fill can never overwrite a later staff write. Public reads never fill. Until then, "owns a shop" is read in both shapes (`ownedBy` in the model): `ownerId`, or no `ownerId` and first in `shopMg`.

Six guards, always after `JWTAuthMiddleware`:

| Guard | Lets through | Otherwise |
|---|---|---|
| `isAdministrator` | the `admin` role (the account routes) | `403 "Administrator only"` |
| `canCreateShops` | the `shopMg` or `admin` role (creating a shop) | `403 "Shop Manager Only!!"` |
| `isShopManager` | any member of the shop in `:shopId`, or an administrator | `403 "Shop Manager Only!"`, or `404 "Shop Not Found!"` |
| `isShopOwner` | the owner of the shop in `:shopId`, or an administrator | `403 "Only the owner can do this"`, or `404 "Shop Not Found!"` |
| `allows(ability)`, after `isShopManager` | a member whose role holds the ability (below), or an administrator | `403 "Your role on this shop doesn't allow this"` |
| a cart's own checks | the cart must belong to the table in the URL, and a cart read by id only to a diner who started it or has a selection on it | `404 "Cart Not Found!"` |

The two shop guards set `req.shopRole` to how the caller got through (`admin`, or their member role), and the controllers behind them no longer filter on `shopMg` themselves: the guard is the one place that decides.

### What each role may do

The routes never name roles. Each names an **ability**, and one table (`shops/roles.ts`, `ABILITIES`) says which roles hold it; `can(role, ability)` is the one place a role becomes abilities, and an administrator holds every one. Every operation behind an ability guard publishes it in the OpenAPI document as `x-ability` (the fact the server checks) and the roles holding it as `x-roles` (the current assignment), and `tests/openapi.test.ts` reads the guard off each route and checks the document says the same; the front end keeps a mirror of the table and its contract test is to check it against the same fields ([known-gaps.md](./known-gaps.md#accepted-residuals)). Were roles ever a shop's own, `can()` would read the shop's table and nothing else would change. ● allowed, ○ refused; every row reads "or an administrator".

| Ability | Routes | Owner | Manager | Till | Floor | Kitchen |
|---|---|---|---|---|---|---|
| `shop.own` | `DELETE /shops/:shopId`, `PUT /shops/:shopId/owner` (`isShopOwner`) | ● | ○ | ○ | ○ | ○ |
| `shop.edit` | `PUT /shops/:shopId`, `PUT …/cover` | ● | ● | ○ | ○ | ○ |
| `menu.edit` | `POST …/menu`, `PUT …/menu/:itemId` (any body but the switch alone), `PUT …/menu/:itemId/img`, `DELETE …/menu/:itemId` | ● | ● | ○ | ○ | ○ |
| `menu.availability` | `PUT …/menu/:itemId` with a body of `available` and nothing else | ● | ● | ● | ● | ● |
| `tables.edit` | `POST …/tables`, `PUT …/tables/:tableId`, `DELETE …/tables/:tableId` | ● | ● | ○ | ○ | ○ |
| `tables.read` | `GET …/tables/status`, `GET …/tables/:tableId/carts` | ● | ● | ● | ● | ● |
| `carts.fix` | `…/carts/:cartId/releaseSelection`, `removeItem`, `close`, `mergeInto` | ● | ● | ● | ● | ○ |
| `payments.manage` | `…/refunds`, `…/refunds/:refundId/retry`, `…/payments/:paymentId/check`, `…/paybacks/:paybackId/done` | ● | ● | ● | ○ | ○ |
| `sales.read` | `GET …/sales`, `GET …/sales/export` | ● | ● | ○ | ○ | ○ |
| `staff.read` | `GET …/staff` | ● | ● | ● | ● | ● |

The staff writes (`POST …/staff`, `PUT …/staff/:userId`, `DELETE …/staff/:userId`) carry no ability: who may handle whom depends on the target's role as well as the caller's, so the controller decides (`mayHandle`, below). The menu edit is the one route two abilities share: the ability guard (`allowsMenuChange`) runs after validation and the item lookup and reads the validated body, whose keys are exactly what was sent (zod strips unknown ones), so a body of `available` alone is the switch and anything else, an empty body included, is an edit; a malformed body answers `400` and an item not on this shop's menu `404` before the role is checked. On every other route the ability is checked before validation and before any upload, as membership is. Every guard that decides by ability carries the abilities it checks as a property (`allows("sales.read").abilities`), which is what the tests read. `GET /shops/me` needs only a sign-in and answers the shops the caller is a member of (`[]` for none, every shop for an administrator). Creating a shop makes the caller its owner; an administrator names the owner (`ownerId`, any account but another administrator's: `404 "Owner not found"`, `409 "An administrator can't be a member of a shop"`), and from anyone else that field is `403 "Only an administrator names an owner"`.

### Who joins a shop, and how

Nobody applies and nobody is invited: accounts are made by the person above them. An administrator creates accounts with any role (`POST /users`); a shop's owner adds its managers and, like its managers, the three roles below manager (`POST /shops/:shopId/staff`). Adding someone is **by email, create or attach** (`staffControllers.ts`): an address with an account attaches that account, name and password untouched (`200`); one without gets an account created from the name, surname and first password sent (`201`; account role `customer` whatever membership role was asked for; `createdBy` the caller), and the caller tells the person the password, which they change on their account page. Refused: the caller's own address (`400`), an address already on the shop (`409 "Already a member"`), an administrator's (`409 "An administrator can't be a member of a shop"`), a `manager` from a manager (`403 "Only the owner adds managers"`), anyone from a till, floor or kitchen member (`403 "Your role on this shop doesn't allow this"`), a new account without its three fields (`400 "Validation failed"`, each `"Required for a new account"`). The membership is written in one update conditioned on the person's absence, so two adds of one person land once; an account registered in the same instant is attached rather than duplicated. Every staff write is matched on what the caller read (the member still there and not the owner, the owner still the owner), and one that finds the staff changed in the same instant answers `409 "The shop's staff changed, please retry"`.

Who may handle whom is one rule, `mayHandle(callerRole, targetRole)`, on all three staff writes: the owner (or an administrator) handles anyone but the owner; a manager only `till`, `floor` and `kitchen`; the three below nobody. **Changing a role** (`PUT /shops/:shopId/staff/:userId`, body `{ role }`, any role but owner) needs the caller allowed to handle both the role the member has and the new one, so a manager moves the three below among themselves and never makes or unmakes a manager (`403 "Only the owner changes a manager's role"`), and nobody changes their own; the owner's row is refused (`403 "The owner's role changes by handing the shop over"`); the same role again is `409 "Already that role"`. It is one update matched on the member still holding the role just read, so a hand-over, a removal or another change landing in the same instant answers `409 "The shop's staff changed, please retry"`. **Removing** (`DELETE /shops/:shopId/staff/:userId`): the owner or an administrator removes anyone but the owner; a manager only the three below (`403 "Only the owner removes a manager"` for a manager); any member themselves. The owner is never removed (`403 "The owner can't be removed"`): the shop is **handed over** first (`PUT /shops/:shopId/owner`, owner or administrator), which makes a member the owner and the previous owner a manager in one update matched on the current owner. Removing a member never deletes their account: an account may dine, belong to other shops, or be the caller's own.

**Accounts** (`isAdministrator`): `GET /users` lists them, newest first, with the shops each is a member of and its role on each; `POST /users` creates one with any role; `PUT /users/:userId/role` sets a role, never the caller's own (`400 "You can't change your own role"`), never `admin` for an account on a shop (`409 "Hand over or leave their shops first"`); `DELETE /users/:userId` deletes one, never the caller's own (`400 "Another administrator deletes your account"`), never one that owns a shop (`409 "Transfer or delete their shops first"`). The own-account rule is what keeps the last administrator: another administrator would have to exist to demote or delete them, so only two administrators acting on each other in the same instant can leave none; the database is the way back ([operations.md](./operations.md#the-first-administrator)). Creating or attaching people is limited to `PEOPLE_ADDED_PER_HOUR` (default 20) per caller ([api.md](./api.md#rate-limits)).

The table's cart (`GET /carts/tables/:tableId`) is **public** by design: anyone at the table, signed in or not, sees the order. What the public view strips (payment and refund records, the manager log, the providers' ids, other diners' notices) is in [data-model.md](./data-model.md). Ordering, selecting and paying need a signed-in user, since payments and selections are theirs.

## CORS and the proxy

Browsers may call the API from the front end's origins (`FRONTEND_DEV_URL`, `FRONTEND_PROD_URL`) and from the API's own origin (Swagger UI at `/docs`), always with credentials. A request with no `Origin` header (curl, server to server, Stripe) is never a cross-site browser request and passes. Anything else is refused. The server sits behind one proxy (`trust proxy: 1`), so the own-origin check and client addresses read `X-Forwarded-*`.

Validation runs after authentication on every mutating route (`400 { message: "Validation failed", details }`), and the rate limit on cart edits after both; see [api.md](./api.md).
