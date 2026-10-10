import { describe, it, expect } from "@jest/globals"
import fs from "fs"
import path from "path"
import { ENV_KEYS } from "../settings/env"

// The docs that live beside the code drift from it silently: these catch the
// drift the code can see. (What the OpenAPI document says is checked in
// openapi.test.ts.)

const root = path.join(__dirname, "../..")
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8")

describe("the environment variables", () => {
    it("are each documented in the README's table, and nothing else is", () => {
        const table = [...read("README.md").matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1])
        expect(table.sort()).toEqual([...ENV_KEYS].sort())
    })

    it("are each in .env.example, and nothing else is", () => {
        const example = [...read(".env.example").matchAll(/^#? ?([A-Z_]+)=/gm)].map((m) => m[1])
        expect(example.sort()).toEqual([...ENV_KEYS].sort())
    })
})

// The Markdown the repository ships: the root files and docs/. (Not every
// .md on disk: a developer's git-excluded notes aren't the project's docs.)
const markdownFiles = () => [
    "README.md",
    "CHANGELOG.md",
    ...fs.readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => path.join("docs", f)),
].sort()

// GitHub's anchor for a heading: lowercased, punctuation dropped, spaces to dashes.
const anchor = (heading: string) =>
    heading.trim().toLowerCase().replace(/[`*_~]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-")

const headingsOf = (markdown: string) => {
    const ids = new Set<string>()
    for (const [, text] of markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) ids.add(anchor(text))
    // Explicit anchors: <div id="top">, <a id="…">, <a name="…">.
    for (const [, id] of markdown.matchAll(/<(?:div|a|span|p)\s[^>]*?(?:id|name)="([^"]+)"/g)) ids.add(id)
    return ids
}

describe("the Markdown files", () => {
    it("link only to files and headings that exist", () => {
        const broken: string[] = []
        for (const file of markdownFiles()) {
            const markdown = read(file)
            const headings = headingsOf(markdown)
            // Links and images: [text](target) and href="target", without the
            // code blocks, where a path may be an example.
            const prose = markdown.replace(/```[\s\S]*?```/g, "")
            const targets = [
                ...[...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]),
                ...[...prose.matchAll(/href="([^"]+)"/g)].map((m) => m[1]),
            ]
            for (const target of targets) {
                if (/^(https?:|mailto:)/.test(target)) continue
                const [file_, hash] = target.split("#")
                if (file_) {
                    const resolved = path.join(root, path.dirname(file), file_)
                    if (!fs.existsSync(resolved)) {
                        broken.push(`${file}: ${target} (no such file)`)
                        continue
                    }
                    if (hash && !headingsOf(fs.readFileSync(resolved, "utf8")).has(hash)) broken.push(`${file}: ${target} (no such heading)`)
                } else if (hash && !headings.has(hash)) {
                    broken.push(`${file}: ${target} (no such heading)`)
                }
            }
        }
        expect(broken).toEqual([])
    })
})
