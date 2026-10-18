import { Paths, empty, error, fromZod, imageBody, json, jsonBody, param, queryParams, ref, sharedResponse, uploadErrors } from "../helpers"
import { createUserSchema, deleteMeSchema, editMeSchema, listUsersSchema, setRoleSchema } from "../../services/users/schemas"

// services/users/routes.ts, controllers.ts.

const tag = ["Users"]

const signedIn = { 401: sharedResponse("Unauthorized"), 404: sharedResponse("UserGone") }
const accounts = ["Accounts"]
// JWTAuthMiddleware then isAdministrator.
const administrator = { 401: sharedResponse("Unauthorized"), 403: sharedResponse("AdministratorOnly") }

export const userPaths: Paths = {
    "/users": {
        get: {
            operationId: "listUsers", tags: accounts,
            summary: "A page of accounts",
            description: "Newest first, each with the shops it is a member of and its role on each. `q` matches the name, surname or email, case aside. An empty parameter counts as absent.",
            parameters: queryParams(listUsersSchema, {
                q: "Text to search for (up to 100 characters); empty or absent lists every account",
                role: "Only accounts with this role",
                page: "1 is the first (default 1)",
                limit: "Accounts per page, 1 to 50 (default 20)",
            }),
            responses: {
                200: json("A page", ref("AccountPage")),
                400: sharedResponse("ValidationFailed"),
                ...administrator,
                404: sharedResponse("UserGone"),
                500: sharedResponse("ServerError"),
            },
        },
        post: {
            operationId: "createUser", tags: accounts,
            summary: "Create an account",
            description: "With any role (`customer` unless said); `createdBy` is the administrator. The person is told the password and changes it on their account page. Counts towards the administrator's people-added limit.",
            requestBody: jsonBody(fromZod(createUserSchema, { email: "Trimmed and lowercased", password: "At least 8 characters: the account's first password", role: "customer unless said" })),
            responses: {
                201: json("The new account", ref("User")),
                400: sharedResponse("ValidationFailed"),
                ...administrator,
                404: sharedResponse("UserGone"),
                409: error('"Email already registered"'),
                429: sharedResponse("TooManyAdded"),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/users/{userId}": {
        delete: {
            operationId: "deleteUser", tags: accounts,
            summary: "Delete an account",
            description: "The shops it works at lose it; its sessions end. Not the caller's own (so the last administrator stays), not one that owns a shop (handed over or deleted first).",
            parameters: [param("userId")],
            responses: {
                204: empty("Deleted"),
                400: error('"Another administrator deletes your account": the caller\'s own'),
                ...administrator,
                404: error('"User not found": no such account; "User not found!": the caller\'s is gone'),
                409: error('"Transfer or delete their shops first": the account owns a shop'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/users/{userId}/role": {
        put: {
            operationId: "setRole", tags: accounts,
            summary: "Set an account's role",
            description: "Not the caller's own, so the last administrator can't demote themselves and another would have to exist to demote them. `admin` only for an account on no shop (an administrator is never a member).",
            parameters: [param("userId")],
            requestBody: jsonBody(fromZod(setRoleSchema)),
            responses: {
                200: json("The account as it is now", ref("User")),
                400: error('"Validation failed" (details); "You can\'t change your own role"'),
                ...administrator,
                404: error('"User not found": no such account; "User not found!": the caller\'s is gone'),
                409: error('"Hand over or leave their shops first": `admin` for an account on a shop'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/users/me": {
        get: {
            operationId: "getMe", tags: tag,
            summary: "The signed-in account",
            responses: { 200: json("The account", ref("User")), ...signedIn },
        },
        put: {
            operationId: "editMe", tags: tag,
            summary: "Edit the signed-in account",
            description: "Changing the email or the password of an account that has a password needs `currentPassword`; a wrong one counts towards the account's limit. A Google-only account can't be given a password. A new password signs the account's other sessions out (new cookies for this one).",
            requestBody: jsonBody(fromZod(editMeSchema, {
                email: "Trimmed and lowercased",
                password: "At least 8 characters; not allowed on a Google-only account",
                currentPassword: "Required to change the email or password of an account that has one",
            })),
            responses: {
                200: json("The account as it is now", ref("User")),
                400: error('"Validation failed" (details); "Enter your current password to change your email or password"'),
                403: error('"Your current password is incorrect"; "This account signs in with Google, so it can\'t have a password"'),
                409: error('"Email already registered"'),
                429: sharedResponse("TooManyWrongPasswords"),
                500: error('"An Error ocurred while updating the user"'),
                ...signedIn,
            },
        },
        delete: {
            operationId: "deleteMe", tags: tag,
            summary: "Delete the signed-in account",
            description: "Needs `currentPassword` when the account has a password. The shops the account owns must be handed over or deleted first; the shops it merely works at lose it. An administrator's account is deleted by another administrator. Clears the cookies.",
            requestBody: jsonBody(fromZod(deleteMeSchema, { currentPassword: "Required when the account has a password" })),
            responses: {
                204: empty("Deleted; cookies cleared"),
                400: error('"Validation failed" (details); "Enter your current password to delete your account"'),
                403: error('"Your current password is incorrect"'),
                409: error('"Delete your shops first": the account owns a shop (hand it over or delete it); "An administrator\'s account is deleted by another administrator"'),
                429: sharedResponse("TooManyWrongPasswords"),
                500: error('"An Error ocurred while deleting the user"'),
                ...signedIn,
            },
        },
    },
    "/users/me/avatar": {
        put: {
            operationId: "editMyAvatar", tags: tag,
            summary: "Upload a new avatar",
            description: "One image, uploaded to Cloudinary; the replaced one is deleted there if this app uploaded it.",
            requestBody: imageBody("avatar"),
            responses: {
                200: json("The account with its new avatar", ref("User")),
                ...uploadErrors,
                500: error('"An Error ocurred while updating the user\'s avatar"'),
                ...signedIn,
            },
        },
    },
}
