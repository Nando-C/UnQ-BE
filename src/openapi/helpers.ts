import { z, ZodType } from "zod"

// Building blocks for the OpenAPI document (index.ts). Loose types on purpose:
// the document is checked whole against the OpenAPI 3.1 schema in
// tests/openapi.test.ts, which catches more than a hand-kept type would.

export type JsonSchema = Record<string, unknown>
export type Parameter = { name: string; in: "path" | "query" | "cookie" | "header"; required?: boolean; description?: string; schema: JsonSchema }
export type Response = { description: string; content?: Record<string, { schema: JsonSchema }>; headers?: Record<string, unknown> }
export type Operation = {
    operationId: string
    tags: string[]
    summary: string
    description?: string
    security?: Record<string, string[]>[]
    parameters?: (Parameter | { $ref: string })[]
    requestBody?: { required: true; content: Record<string, { schema: JsonSchema }> }
    responses: Record<string, Response | { $ref: string }>
}
export type Paths = Record<string, Record<string, Operation>>

const MAX = Number.MAX_SAFE_INTEGER

// Bounds zod adds for `int()` that say nothing a reader needs.
const tidy = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(tidy)
    if (!node || typeof node !== "object") return
    const o = node as Record<string, unknown>
    if (o.maximum === MAX) delete o.maximum
    if (o.minimum === -MAX) delete o.minimum
    Object.values(o).forEach(tidy)
}

// A request body's schema from the zod schema the route validates with
// (middlewares/validate.ts), as the client sends it (io: "input": before
// trims, defaults and transforms). `describe` adds a description per field and
// throws on a field the schema doesn't have, so a renamed field can't keep a
// stale description.
export const fromZod = (schema: ZodType, describe: Record<string, string> = {}): JsonSchema => {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema
    delete json.$schema
    tidy(json)
    const properties = (json.properties ?? {}) as Record<string, JsonSchema>
    for (const [field, text] of Object.entries(describe)) {
        if (!properties[field]) throw new Error(`fromZod: no field "${field}" in the schema`)
        properties[field].description = text
    }
    return json
}

// A query's parameters from the zod schema the route validates it with
// (`validate(schema, "query")`): one parameter per field.
export const queryParams = (schema: ZodType, describe: Record<string, string> = {}): Parameter[] => {
    const json = fromZod(schema, describe)
    const required = new Set((json.required as string[] | undefined) ?? [])
    return Object.entries(json.properties as Record<string, JsonSchema>).map(([name, field]) => {
        const { description, ...rest } = field
        return { name, in: "query", required: required.has(name), ...(description ? { description: String(description) } : {}), schema: rest }
    })
}

export const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` })
export const array = (items: JsonSchema): JsonSchema => ({ type: "array", items })
export const param = (name: string) => ({ $ref: `#/components/parameters/${name}` })
export const sharedResponse = (name: string) => ({ $ref: `#/components/responses/${name}` })

export const json = (description: string, schema: JsonSchema): Response =>
    ({ description, content: { "application/json": { schema } } })
export const empty = (description: string): Response => ({ description })

// An error answer: `{ message, details?, reason? }` (errorMiddlewares.ts). The
// description lists the messages this status answers with.
export const error = (description: string): Response => json(description, ref("Error"))

// The one-image upload the routes take (settings/cloudinary.ts).
export const imageBody = (field: string): Operation["requestBody"] => ({
    required: true,
    content: {
        "multipart/form-data": {
            schema: {
                type: "object",
                required: [field],
                properties: {
                    [field]: { type: "string", format: "binary", description: "JPEG, PNG, WebP, GIF, AVIF or HEIC, at most 5 MB" },
                },
            },
        },
    },
})
export const uploadErrors = {
    400: error('"Only JPEG, PNG, WebP, GIF, AVIF or HEIC images can be uploaded"; "No image was sent (field …)"'),
    413: error('"The image is too large (max 5 MB)"'),
}

export const jsonBody = (schema: JsonSchema): Operation["requestBody"] =>
    ({ required: true, content: { "application/json": { schema } } })

// Open to everyone: no cookie needed (the document's default is cookieAuth).
export const PUBLIC: Operation["security"] = []
