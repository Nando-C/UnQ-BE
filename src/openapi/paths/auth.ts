import { Paths, PUBLIC, array, empty, error, fromZod, json, jsonBody, param, ref, sharedResponse } from "../helpers"
import { loginSchema, registerSchema } from "../../services/auth/schemas"

// services/auth/routes.ts, controllers.ts, tools.ts, oauth.ts.

const tag = ["Auth"]

const cookiesSet = "Sets the `accessToken` (15 minutes) and `refreshToken` (4 weeks) cookies: HttpOnly, Secure, SameSite=None. The sign-in is a session of its own on the account (a device), beside the ones other devices hold: at most 10, the oldest sign-in going beyond that."

const signedIn = { 401: sharedResponse("Unauthorized"), 404: sharedResponse("UserGone") }

export const authPaths: Paths = {
    "/auth/register": {
        post: {
            operationId: "registerUser", tags: tag, security: PUBLIC,
            summary: "Create an account and sign in",
            description: `A new account with the customer role (the manager role is set in the database). ${cookiesSet} The avatar is a generated initials image.`,
            requestBody: jsonBody(fromZod(registerSchema, { email: "Trimmed and lowercased before it's checked and stored", password: "At least 8 characters" })),
            responses: {
                201: json("The new account", ref("User")),
                400: error('"Validation failed" (details), or the model\'s own validation message'),
                409: error('"Email already registered"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/auth/login": {
        post: {
            operationId: "loginUser", tags: tag, security: PUBLIC,
            summary: "Sign in with email and password",
            description: `${cookiesSet} Wrong passwords count towards the account's limit (lib/passwordLimit.ts); an email with no account, or a Google-only account, doesn't.`,
            requestBody: jsonBody(fromZod(loginSchema)),
            responses: {
                200: json("The account", ref("User")),
                400: sharedResponse("ValidationFailed"),
                401: error('"Invalid credentials": no such account, no password on it, or the wrong password'),
                429: sharedResponse("TooManyWrongPasswords"),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/auth/refreshToken": {
        post: {
            operationId: "tokenRefresh", tags: tag, security: PUBLIC,
            summary: "Rotate the session's tokens",
            description: "Reads the `refreshToken` cookie. A valid one that is its session's current token is swapped atomically for a new pair (both cookies set again). One its session replaced in the last minute answers 401 with `reason: \"superseded\"` and leaves the cookies alone: another tab of the same device just refreshed, and the request can be resent with the cookies that tab got. Any other invalid one (expired, replaced earlier, signed with another key, account gone, session gone: a logout, a revocation, a password change, a sign-in on too many devices) answers 401 and clears both cookies: the session is over.",
            parameters: [{ name: "refreshToken", in: "cookie", required: true, schema: { type: "string" } }],
            responses: {
                200: empty("New cookies set; no body"),
                400: error('"Refresh token MUST be provided!": no cookie'),
                401: error('"Invalid token", with `reason: "superseded"` when another tab just rotated it (cookies kept); without it the cookies are cleared'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/auth/logout": {
        get: {
            operationId: "logoutUser", tags: tag,
            summary: "Sign out",
            description: "Ends this device's session and clears both cookies. The account's other devices stay signed in.",
            responses: {
                204: empty("Signed out"),
                ...signedIn,
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/auth/sessions": {
        get: {
            operationId: "listSessions", tags: tag,
            summary: "The devices signed in",
            description: "The account's sessions in sign-in order, the caller's marked `current`. A device that hasn't refreshed in four weeks holds an expired token and isn't listed. Never the tokens or their ids.",
            responses: {
                200: json("The sessions", array(ref("Session"))),
                ...signedIn,
            },
        },
    },
    "/auth/sessions/{sessionId}": {
        delete: {
            operationId: "revokeSession", tags: tag,
            summary: "Sign one device out",
            description: "Ends that session: its next refresh fails, so the device is a guest's within 15 minutes (the access token's life). Revoking the caller's own session also clears the cookies, like a logout.",
            parameters: [param("sessionId")],
            responses: {
                204: empty("Signed out; cookies cleared when it was this device's"),
                ...signedIn,
                404: error('"Session not found": not one of the account\'s sessions (or "User not found!")'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/auth/googleLogin": {
        get: {
            operationId: "googleLogin", tags: tag, security: PUBLIC,
            summary: "Start a Google sign-in",
            description: "Redirects the browser to Google (scopes profile and email). Open it as a navigation, not an XHR.",
            responses: {
                302: empty("To Google's consent page"),
            },
        },
    },
    "/auth/googleRedirect": {
        get: {
            operationId: "googleRedirect", tags: tag, security: PUBLIC,
            summary: "Google's callback",
            description: "Where Google sends the browser back (its callback URL is `PUBLIC_API_URL/auth/googleRedirect`). An account already linked by Google id signs in; otherwise an account with the same verified email is linked (its password is removed: only Google signs it in from now on); a new email gets a new account. An unverified email that matches an account, or no email, signs nobody in. Sets the cookies and redirects to the front end's origin (`FRONTEND_URL`, else `FRONTEND_DEV_URL`); a sign-in that can't be matched safely redirects to its `/login` page instead. On a dev server with no front end running, that last redirect fails to connect; the cookies are set all the same (check with GET /users/me from /docs).",
            parameters: [{ name: "code", in: "query", required: true, description: "Google's authorization code", schema: { type: "string" } }],
            responses: {
                302: empty("To the front end, signed in; or to its /login page, not signed in"),
                500: sharedResponse("ServerError"),
            },
        },
    },
}
