import { Paths, empty, error, fromZod, imageBody, json, jsonBody, ref, sharedResponse, uploadErrors } from "../helpers"
import { deleteMeSchema, editMeSchema } from "../../services/users/schemas"

// services/users/routes.ts, controllers.ts.

const tag = ["Users"]

const signedIn = { 401: sharedResponse("Unauthorized"), 404: sharedResponse("UserGone") }

export const userPaths: Paths = {
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
            description: "Needs `currentPassword` when the account has a password. A manager's shops must be deleted first. Clears the cookies.",
            requestBody: jsonBody(fromZod(deleteMeSchema, { currentPassword: "Required when the account has a password" })),
            responses: {
                204: empty("Deleted; cookies cleared"),
                400: error('"Validation failed" (details); "Enter your current password to delete your account"'),
                403: error('"Your current password is incorrect"'),
                409: error('"Delete your shops first"'),
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
