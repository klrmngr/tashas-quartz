/**
 * Quartz transformer plugin: renders Obsidian `base` code blocks as static HTML tables.
 *
 * Drop this file into quartz/plugins/transformers/ in your Quartz install, then add
 * Plugin.BaseQuery() to the transformers array in quartz.config.ts.
 *
 * Supported filters:
 *   file.inFolder("path")        — vault path prefix match
 *   file.hasLink(this.file)      — files that wikilink to the current page
 *   file.hasLink("Name")         — files that wikilink to a specific page name
 *   locations.contains(this.file)— frontmatter `locations` array contains current page
 *   formula.LinkedIndirectly     — locations.contains OR any sub-location contains (2-hop)
 *
 * Filter groups: `and` and `or` are both supported and can be nested.
 */

import { QuartzTransformerPlugin } from "../types"
import { visit } from "unist-util-visit"
import { parse as parseYaml } from "yaml"
import path from "path"
import fs from "fs"

// ---------------------------------------------------------------------------
// Vault index built once at plugin init
// ---------------------------------------------------------------------------

interface VaultFile {
  /** Relative to vault root, e.g. "Compendium/NPC's/Gale.md" */
  vaultPath: string
  /** Bare filename without extension, e.g. "Gale" */
  name: string
  /** Parsed frontmatter */
  fm: Record<string, unknown>
  /** Wikilink targets found in the body (bare names, no brackets) */
  links: Set<string>
}

const SKIP_DIRS = new Set([".obsidian", "Assets"])

function walkVault(dir: string, root: string, out: VaultFile[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      walkVault(full, root, out)
    } else if (e.name.endsWith(".md")) {
      const vaultPath = path.relative(root, full)
      const name = path.basename(e.name, ".md")
      let content = ""
      try {
        content = fs.readFileSync(full, "utf-8")
      } catch {}
      out.push({ vaultPath, name, fm: parseFm(content), links: parseLinks(content) })
    }
  }
}

function parseFm(content: string): Record<string, unknown> {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  try {
    return (parseYaml(m[1]) as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
}

const WIKILINK_RE = /\[\[([^\]|#\n]+)/g

function parseLinks(content: string): Set<string> {
  const links = new Set<string>()
  let m: RegExpExecArray | null
  WIKILINK_RE.lastIndex = 0
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    // Keep only the bare name (drop path prefix if present)
    const raw = m[1].trim()
    links.add(raw.includes("/") ? path.basename(raw) : raw)
  }
  return links
}

/** Extract bare name from an Obsidian wikilink value like "[[Elven Harbour]]" */
function wikiBare(val: string): string {
  const m = val.match(/\[\[([^\]|#]+)/)
  if (m) return m[1].trim().includes("/") ? path.basename(m[1].trim()) : m[1].trim()
  return val.trim()
}

/** Return the `locations` frontmatter of a file as an array of bare page names */
function fmLocations(f: VaultFile): string[] {
  const raw = f.fm["locations"]
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).map(v => wikiBare(String(v)))
}

// ---------------------------------------------------------------------------
// Filter evaluator
// ---------------------------------------------------------------------------

type FilterNode = string | { and: FilterNode[] } | { or: FilterNode[] }

function evalFilter(
  node: FilterNode,
  candidate: VaultFile,
  current: VaultFile,
  allByName: Map<string, VaultFile>,
  formulas: Record<string, string>,
): boolean {
  if (typeof node === "string") {
    return evalLeaf(node.trim(), candidate, current, allByName, formulas)
  }
  if ("and" in node) {
    return (node.and as FilterNode[]).every(n => evalFilter(n, candidate, current, allByName, formulas))
  }
  if ("or" in node) {
    return (node.or as FilterNode[]).some(n => evalFilter(n, candidate, current, allByName, formulas))
  }
  return true
}

function evalLeaf(
  expr: string,
  f: VaultFile,
  cur: VaultFile,
  allByName: Map<string, VaultFile>,
  formulas: Record<string, string>,
): boolean {
  // file.inFolder("path")
  const inFolder = expr.match(/^file\.inFolder\("([^"]+)"\)$/)
  if (inFolder) return f.vaultPath.startsWith(inFolder[1])

  // file.hasLink(this.file)
  if (expr === "file.hasLink(this.file)") return f.links.has(cur.name)

  // file.hasLink("Name")
  const hasLinkStr = expr.match(/^file\.hasLink\("([^"]+)"\)$/)
  if (hasLinkStr) return f.links.has(hasLinkStr[1])

  // locations.contains(this.file)
  if (expr === "locations.contains(this.file)") return fmLocations(f).includes(cur.name)

  // formula.LinkedIndirectly  (direct location OR 2-hop via sub-location)
  if (expr === "formula.LinkedIndirectly") {
    const locs = fmLocations(f)
    if (locs.includes(cur.name)) return true
    return locs.some(locName => {
      const locFile = allByName.get(locName)
      return locFile ? fmLocations(locFile).includes(cur.name) : false
    })
  }

  // Unknown formula reference — skip (don't exclude)
  if (expr.startsWith("formula.")) return true

  return true
}

// ---------------------------------------------------------------------------
// hast helpers
// ---------------------------------------------------------------------------

function hText(value: string) {
  return { type: "text" as const, value }
}

function hEl(tag: string, props: Record<string, unknown>, children: unknown[]) {
  return { type: "element" as const, tagName: tag, properties: props, children }
}

function buildTable(view: Record<string, unknown>, rows: VaultFile[]): unknown {
  const colName = (view.name as string | undefined) ?? "Name"

  const headerRow = hEl("tr", {}, [hEl("th", {}, [hText(colName)])])
  const thead = hEl("thead", {}, [headerRow])

  const bodyRows =
    rows.length === 0
      ? [hEl("tr", {}, [hEl("td", { className: ["base-empty"] }, [hText("—")])])]
      : rows.map(r => {
          const href = "/" + r.vaultPath.replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/")
          return hEl("tr", {}, [hEl("td", {}, [hEl("a", { href }, [hText(r.name)])])])
        })

  const tbody = hEl("tbody", {}, bodyRows)
  const table = hEl("table", { className: ["base-query-table"] }, [thead, tbody])
  return hEl("div", { className: ["base-query"] }, [table])
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const BaseQuery: QuartzTransformerPlugin = () => {
  let allFiles: VaultFile[] | null = null
  let byName: Map<string, VaultFile> | null = null

  function getIndex(vaultRoot: string): [VaultFile[], Map<string, VaultFile>] {
    if (allFiles && byName) return [allFiles, byName]
    allFiles = []
    walkVault(vaultRoot, vaultRoot, allFiles)
    byName = new Map(allFiles.map(f => [f.name, f]))
    return [allFiles, byName]
  }

  return {
    name: "BaseQuery",

    htmlPlugins(ctx) {
      return [
        () => (tree, file) => {
          const vaultRoot = ctx.argv.directory
          const [allFiles, byName] = getIndex(vaultRoot)

          const filePath = (file.data.filePath as string | undefined) ?? ""
          const currentName = path.basename(filePath, ".md")
          const currentFile = byName.get(currentName) ?? {
            vaultPath: filePath,
            name: currentName,
            fm: {},
            links: new Set<string>(),
          }

          visit(tree, "element", (node: any, index: number | null, parent: any) => {
            if (
              node.tagName !== "pre" ||
              node.children?.[0]?.tagName !== "code" ||
              !node.children[0].properties?.className?.includes("language-base")
            )
              return

            const raw: string = node.children[0].children?.[0]?.value ?? ""
            let query: any
            try {
              query = parseYaml(raw)
            } catch {
              return
            }

            const views: any[] = query?.views ?? []
            const formulas: Record<string, string> = query?.formulas ?? {}

            if (views.length === 0) return

            // Build one table per view, wrapped in a single container div
            const tables = views.map((view: any) => {
              const filterRoot: FilterNode = view.filters ?? { and: [] }

              let results = allFiles.filter(f =>
                evalFilter(filterRoot, f, currentFile, byName!, formulas),
              )

              const order: string[] = view.order ?? []
              if (order.includes("file.name")) {
                results = results.slice().sort((a, b) => a.name.localeCompare(b.name))
              }

              return buildTable(view, results)
            })

            const replacement =
              tables.length === 1
                ? tables[0]
                : hEl("div", { className: ["base-query-multi"] }, tables)

            if (parent && index !== null) {
              parent.children.splice(index, 1, replacement)
            }
          })
        },
      ]
    },
  }
}
