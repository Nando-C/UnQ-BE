import { Paths, abilityOf, empty, error, fromZod, imageBody, json, jsonBody, param, ref, sharedResponse, uploadErrors } from "../helpers"
import { createMenuItemSchema, editMenuItemSchema } from "../../services/menus/schemas"

// services/menus/routes.ts, controllers.ts. Mounted under /shops next to the shop routes.

const tag = ["Menu"]

const signedIn = { 401: sharedResponse("Unauthorized") }
// JWTAuthMiddleware, isShopManager, the ability guard (x-ability), then (where the route has it) isOnShopMenu.
const manager = { ...signedIn, 403: sharedResponse("NotThisShopsManager") }

const itemFields = {
    price: "In pounds, to the penny (at most 2 decimals): refunds price each unit on its own",
    available: "Defaults to true. false marks the item sold out: it can't be added, selected or paid for, and stays flagged in carts that hold it",
}

export const menuPaths: Paths = {
    "/shops/{shopId}/menu": {
        post: {
            operationId: "createMenuItem", tags: tag, ...abilityOf("menu.edit"),
            summary: "Add an item to the shop's menu",
            parameters: [param("shopId")],
            requestBody: jsonBody(fromZod(createMenuItemSchema, itemFields)),
            responses: {
                200: json("The new item", ref("MenuItem")),
                400: sharedResponse("ValidationFailed"),
                ...manager,
                404: error('"Shop Not Found!"'),
                500: sharedResponse("ServerError"),
            },
        },
        get: {
            operationId: "getMenuList", tags: tag,
            summary: "The shop's menu",
            description: "Any signed-in user. Deleted items are not on it.",
            parameters: [param("shopId")],
            responses: {
                200: json("The menu items", { type: "array", items: ref("MenuItem") }),
                ...signedIn,
                404: error('"Shop Not Found!"; "User not found!"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}/menu/{itemId}": {
        get: {
            operationId: "getMenuItem", tags: tag,
            summary: "One item of the shop's menu",
            description: "Any signed-in user. The item must be on this shop's menu.",
            parameters: [param("shopId"), param("itemId")],
            responses: {
                200: json("The item", ref("MenuItem")),
                ...signedIn,
                404: error('"Menu Item Not Found!": no such item, or not on this shop\'s menu; "User not found!"'),
                500: sharedResponse("ServerError"),
            },
        },
        put: {
            operationId: "editMenuItem", tags: tag, ...abilityOf("menu.edit", "menu.availability"),
            summary: "Edit an item",
            description: "Every field optional; only the ones sent change. Two abilities share the route: a body of `available` and nothing else is the availability switch (`menu.availability`, every member's); any other body, an empty one included, is an edit (`menu.edit`, the owner's and managers'). The body is validated and the item looked up before the role is checked, so a malformed body answers 400 and an item not on this shop's menu 404 whatever the role.",
            parameters: [param("shopId"), param("itemId")],
            requestBody: jsonBody(fromZod(editMenuItemSchema, itemFields)),
            responses: {
                200: json("The item as it is now", ref("MenuItem")),
                400: sharedResponse("ValidationFailed"),
                ...manager,
                404: error('"Menu Item Not Found!": no such item, or not on this shop\'s menu; "Shop Not Found!"'),
                500: sharedResponse("ServerError"),
            },
        },
        delete: {
            operationId: "deleteMenuItem", tags: tag, ...abilityOf("menu.edit"),
            summary: "Take an item off the menu",
            description: "The item leaves the shop's menu but is kept, unavailable and marked `deletedFrom`, so carts that hold it still name it (as sold out). It goes for good with the shop.",
            parameters: [param("shopId"), param("itemId")],
            responses: {
                204: empty("Taken off the menu"),
                ...manager,
                404: error('"Menu Item Not Found!": not on this shop\'s menu; "Shop Not Found!"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
    "/shops/{shopId}/menu/{itemId}/img": {
        put: {
            operationId: "editMenuItemImage", tags: tag, ...abilityOf("menu.edit"),
            summary: "Upload an item's image",
            description: "The permission checks run before the upload, so a refused request never reaches Cloudinary. The replaced image is deleted there if this app uploaded it.",
            parameters: [param("shopId"), param("itemId")],
            requestBody: imageBody("image"),
            responses: {
                200: json("The item with its new image", ref("MenuItem")),
                ...uploadErrors,
                ...manager,
                404: error('"Menu Item Not Found!"; "Shop Not Found!"'),
                500: sharedResponse("ServerError"),
            },
        },
    },
}
