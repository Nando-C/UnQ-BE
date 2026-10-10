import { Paths, PUBLIC, json, ref } from "../helpers"

// openapi/routes.ts.

const tag = ["System"]

export const systemPaths: Paths = {
    "/health": {
        get: {
            operationId: "health", tags: tag, security: PUBLIC,
            summary: "Is the server up",
            description: "Always 200 while the process answers; says which version runs and for how long. For the host's health check and a quick look after a deploy.",
            responses: { 200: json("Up", ref("Health")) },
        },
    },
    "/openapi.json": {
        get: {
            operationId: "openapiDocument", tags: tag, security: PUBLIC,
            summary: "This document",
            description: "The API's OpenAPI 3.1 description, built in code from the routes' validation schemas (src/openapi/). A test keeps it complete: every route the server serves is in it, and nothing else.",
            responses: { 200: json("The OpenAPI document", { type: "object" }) },
        },
    },
    "/docs": {
        get: {
            operationId: "docs", tags: tag, security: PUBLIC,
            summary: "Swagger UI",
            description: "This document, browsable, with Try it out. The page loads Swagger UI from a CDN and reads `openapi.json` next to itself.",
            responses: { 200: { description: "The page", content: { "text/html": { schema: { type: "string" } } } } },
        },
    },
}
