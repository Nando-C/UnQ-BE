#!/usr/bin/env node
// Checks an OpenAPI document against the OpenAPI 3.1 schema.
//
//   node src/scripts/validateOpenApi.mjs                      the dev server's (http://localhost:3001/openapi.json)
//   node src/scripts/validateOpenApi.mjs https://…/openapi.json   a deployed one
//   node src/scripts/validateOpenApi.mjs openapi.json          a file
//   … | node src/scripts/validateOpenApi.mjs -                 standard input
//
// Exit 0: valid. 1: invalid, each problem on its own line. 2: couldn't read it.
// tests/openapi.test.ts runs it on the document the code builds (the validator
// is an ES module, which the CommonJS test suite can't import directly).

import { Validator } from "@seriousme/openapi-schema-validator"
import { readFile } from "fs/promises"

const source = process.argv[2] ?? "http://localhost:3001/openapi.json"

const read = async () => {
    if (source === "-") {
        let text = ""
        for await (const chunk of process.stdin) text += chunk
        return text
    }
    if (/^https?:\/\//.test(source)) {
        const res = await fetch(source)
        if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`)
        return res.text()
    }
    return readFile(source, "utf8")
}

let document
try {
    document = JSON.parse(await read())
} catch (error) {
    console.error(`Couldn't read the document: ${error.message}`)
    process.exit(2)
}

const validator = new Validator()
const result = await validator.validate(document)
if (result.valid) {
    console.log(`Valid OpenAPI ${validator.version}: ${Object.keys(document.paths ?? {}).length} paths`)
    process.exit(0)
}
for (const error of result.errors) console.log(`${error.instancePath || "/"}: ${error.message}`)
process.exit(1)
