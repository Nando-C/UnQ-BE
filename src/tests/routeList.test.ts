import { describe, it, expect } from "@jest/globals"
import request from "supertest"
import mongoose from "mongoose"
import "./setup"
import app, { mounts, routeList } from "../server"

describe("the route list printed at startup", () => {
    const routes = routeList()

    it("lists the API's routes, each method once", () => {
        const rows = routes.map((r) => `${r.method} ${r.path}`)
        expect(rows).toEqual(expect.arrayContaining([
            "POST /auth/login",
            "GET /shops",
            "GET /shops/browse",
            "PUT /shops/:shopId/menu/:itemId",
            "POST /carts/tables/:tableId/:cartId/captureCheckout",
        ]))
        expect(new Set(rows).size).toBe(rows.length)
    })

    // It reads the routers in server.ts's mounts table, and shows each route's
    // path as written: a route anywhere else, or one whose path it can't show
    // (a list, a pattern, a wildcard or optional part), would be served but
    // listed wrong or not at all.
    it("can see every route as it's served", () => {
        const onApp = app.router.stack
        expect(onApp.filter((layer) => layer.route || layer.name === "mounted_app")).toEqual([])
        const routers = onApp.filter((layer) => layer.name === "router").map((layer) => layer.handle)
        expect(routers).toEqual(mounts.map(([, router]) => router))
        for (const [, router] of mounts) {
            // Only routes: no nested router, and no middleware for the whole
            // router, which would answer the probe below (401, 429) before
            // Express could say a path isn't served.
            expect(router.stack.filter((l) => !l.route).map((l) => l.name)).toEqual([])
            const unshown = router.stack.filter((l) => l.route && (typeof l.route.path !== "string" || /[*{}()]/.test(l.route.path)))
            expect(unshown.map((l) => String(l.route?.path))).toEqual([])
        }
    })

    // Express answers a path nothing serves with its own "Cannot GET /…"
    // page: every listed route must reach one of ours instead.
    it("names paths the app really serves", async () => {
        const id = String(new mongoose.Types.ObjectId())
        const unserved = []
        for (const { method, path } of routes) {
            const verb = (method === "ALL" ? "get" : method.toLowerCase()) as "get"
            const res = await request(app)[verb](path.replace(/:\w+/g, id))
            if (/Cannot \w+ \//.test(res.text)) unserved.push(`${method} ${path}`)
        }
        expect(unserved).toEqual([])
    })
})
