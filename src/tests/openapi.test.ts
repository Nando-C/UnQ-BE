import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import { spawnSync } from "child_process"
import path from "path"
import "./setup"
import app, { routeAbilities, routeList } from "../server"
import { buildOpenApi } from "../openapi"
import { version } from "../openapi"
import { ABILITIES, Ability, MEMBER_ROLES, holdersOf } from "../services/shops/roles"

// The OpenAPI document (src/openapi/) is the API's contract: these keep it
// complete and well-formed. What each operation says is checked by reading,
// against the controllers (see src/openapi/components.ts for where).

type Operation = { operationId: string; parameters?: ({ $ref: string } | { name: string; in: string })[]; responses: Record<string, unknown>; tags: string[]; security?: unknown[]; description?: string; "x-ability"?: readonly string[]; "x-roles"?: readonly string[] }

const document = buildOpenApi()
const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods as Record<string, Operation>).map(([method, op]) => ({ path, method: method.toUpperCase(), op })))

describe("the OpenAPI document", () => {
    it("lists exactly the routes the server serves", () => {
        // Express's `:param` as OpenAPI's `{param}`.
        const served = routeList().map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, "{$1}")}`).sort()
        const documented = operations.map((o) => `${o.method} ${o.path}`).sort()
        expect(documented).toEqual(served)
    })

    // Through the script (the validator is an ES module this CommonJS suite
    // can't import), which also checks a deployed document.
    it("validates against the OpenAPI 3.1 schema", () => {
        const script = path.join(__dirname, "../scripts/validateOpenApi.mjs")
        const run = spawnSync(process.execPath, [script, "-"], { input: JSON.stringify(document), encoding: "utf8", timeout: 60_000 })
        expect({ status: run.status, out: run.stdout + run.stderr }).toEqual({ status: 0, out: expect.stringMatching(/^Valid OpenAPI 3\.1: \d+ paths\n$/) })
    })

    it("names every path parameter, once, and nothing that isn't in the path", () => {
        const components = document.components.parameters
        for (const { path, method, op } of operations) {
            const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
            const declared = (op.parameters ?? [])
                .map((p) => ("$ref" in p ? components[p.$ref.split("/").pop()!] : p))
                .filter((p) => p.in === "path")
                .map((p) => p.name)
                .sort()
            expect({ route: `${method} ${path}`, declared }).toEqual({ route: `${method} ${path}`, declared: inPath })
        }
    })

    it("gives every operation a unique id, a tag it declares, and a success answer", () => {
        const ids = operations.map((o) => o.op.operationId)
        expect(new Set(ids).size).toBe(ids.length)
        const tags = new Set(document.tags.map((t) => t.name))
        for (const { path, method, op } of operations) {
            const route = `${method} ${path}`
            expect({ route, tags: op.tags.filter((t) => !tags.has(t)) }).toEqual({ route, tags: [] })
            const success = Object.keys(op.responses).filter((status) => /^[23]/.test(status))
            expect({ route, success: success.length > 0 }).toEqual({ route, success: true })
        }
    })

    it("points every $ref at a component that exists", () => {
        const names = {
            schemas: new Set(Object.keys(document.components.schemas)),
            parameters: new Set(Object.keys(document.components.parameters)),
            responses: new Set(Object.keys(document.components.responses)),
        }
        const dangling: string[] = []
        const walk = (node: unknown) => {
            if (Array.isArray(node)) return node.forEach(walk)
            if (!node || typeof node !== "object") return
            for (const [key, value] of Object.entries(node)) {
                if (key === "$ref" && typeof value === "string") {
                    const [, kind, name] = value.match(/^#\/components\/(\w+)\/(\w+)$/) ?? []
                    if (!names[kind as keyof typeof names]?.has(name)) dangling.push(value)
                } else walk(value)
            }
        }
        walk(document)
        expect(dangling).toEqual([])
    })

    // The ability a route's guard checks (auth/middlewares.ts allows, isShopOwner)
    // and the roles holding it travel in the document; the guard is read off the
    // route, so the two can't drift. shops/roles.ts, docs/auth.md#what-each-role-may-do.
    it("says on every guarded operation what the route checks of the caller's role, and who holds it", () => {
        const guards = routeAbilities()
        let carried = 0
        for (const { path, method, op } of operations) {
            const route = `${method} ${path.replace(/\{(\w+)\}/g, ":$1")}`
            const abilities = guards.get(route)
            expect({ route, ability: op["x-ability"] }).toEqual({ route, ability: abilities })
            expect({ route, roles: op["x-roles"] }).toEqual({ route, roles: abilities && holdersOf(abilities as Ability[]) })
            if (abilities) carried++
        }
        expect(carried).toBe(24)
        // Every ability in the table is checked by some route.
        const used = new Set([...guards.values()].flatMap((a) => a ?? []))
        expect([...used].sort()).toEqual(Object.keys(ABILITIES).sort())
    })

    it("explains the roles and the two extensions in its description", () => {
        const text = document.info.description
        for (const role of MEMBER_ROLES) expect(text).toContain(`\`${role}\``)
        expect(text).toContain("`x-ability`")
        expect(text).toContain("`x-roles`")
        type Fields = Record<string, { enum?: string[]; items?: { properties: Fields } }>
        const fields = (name: string) => (document.components.schemas as Record<string, { properties: Fields }>)[name].properties
        expect(fields("Member").role.enum).toEqual([...MEMBER_ROLES])
        expect(fields("StaffMember").role.enum).toEqual([...MEMBER_ROLES])
        expect(fields("ListedUser").shops.items?.properties.role.enum).toEqual([...MEMBER_ROLES])
    })

    it("carries the package's version", () => {
        expect(document.info.version).toBe(version())
        expect(document.info.version).toMatch(/^\d+\.\d+\.\d+/)
    })
})

describe("the system routes", () => {
    it("GET /openapi.json serves the document", async () => {
        const res = await request(app).get("/openapi.json")
        expect(res.status).toBe(200)
        expect(res.type).toBe("application/json")
        expect(res.body.openapi).toBe("3.1.0")
        expect(Object.keys(res.body.paths).sort()).toEqual(Object.keys(document.paths).sort())
    })

    it("GET /docs serves Swagger UI reading the document next to it, opened with or without a trailing slash", async () => {
        for (const path of ["/docs", "/docs/"]) {
            const res = await request(app).get(path)
            expect(res.status).toBe(200)
            expect(res.type).toBe("text/html")
            expect(res.text).toContain("swagger-ui-dist@")
            // The document's URL comes from the page's own path, never relative:
            // "openapi.json" under /docs/ would be /docs/openapi.json.
            const expression = res.text.match(/url: (location\.pathname\.replace\(.*\)),/)?.[1]
            expect(expression).toBeDefined()
            const url = (pathname: string) => new Function("location", `return ${expression}`)({ pathname }) as string
            expect(url("/docs")).toBe("/openapi.json")
            expect(url("/docs/")).toBe("/openapi.json")
            expect(url("/api/docs")).toBe("/api/openapi.json")
            expect(url("/api/docs/")).toBe("/api/openapi.json")
        }
    })

    it("GET /health says the server is up, which version, for how long", async () => {
        const res = await request(app).get("/health")
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ status: "ok", version: version(), uptime: expect.any(Number) })
        expect(res.body.uptime).toBeGreaterThanOrEqual(0)
    })

    it("needs no cookie for any of them", async () => {
        for (const path of ["/health", "/openapi.json", "/docs"]) {
            const res = await request(app).get(path)
            expect({ path, status: res.status }).toEqual({ path, status: 200 })
        }
    })
})
