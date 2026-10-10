import { Router } from "express"
import { buildOpenApi, version } from "./index"

// The API's own routes: health, and its OpenAPI document with Swagger UI.
// Plain routes in a router (not router-level middleware), so server.ts's
// routeList sees them like any other and nothing answers for an unserved path
// (see routeList.test.ts).

const router = Router()

// Built once: it depends only on the code and the configuration.
let document: ReturnType<typeof buildOpenApi> | undefined
export const openApiDocument = () => (document ??= buildOpenApi())

// Swagger UI from a CDN, pinned, reading the document next to this page
// (relative, so it works behind the front end's /api prefix too). Self-hosting
// it would need static-file middleware on the router, which routeList can't
// list; one HTML route can be.
const SWAGGER_UI = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.1"
const docsPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UnQ API</title>
<link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${SWAGGER_UI}/swagger-ui-bundle.js" crossorigin></script>
<script>
window.onload = () => {
  window.ui = SwaggerUIBundle({
    url: "openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    // The auth cookies go with Try it out, so a sign-in there signs in here.
    requestInterceptor: (req) => ({ ...req, credentials: "include" }),
  })
}
</script>
</body>
</html>
`

router.get("/health", (req, res) => {
    res.json({ status: "ok", version: version(), uptime: Math.round(process.uptime()) })
})

router.get("/openapi.json", (req, res) => {
    res.json(openApiDocument())
})

router.get("/docs", (req, res) => {
    res.type("html").send(docsPage)
})

export default router
