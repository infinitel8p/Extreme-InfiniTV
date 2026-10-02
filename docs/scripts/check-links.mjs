// Crawls the built docs as GitHub Pages serves them and reports unresolved internal links.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { BASE } from "../site-base.mjs"

const DIST = fileURLToPath(new URL("../dist/", import.meta.url)).replace(/[\\/]$/, "")

function htmlFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === "pagefind" || name === "_astro" || name === ".prerender") continue
      htmlFiles(full, out)
    } else if (name.endsWith(".html")) {
      out.push(full)
    }
  }
  return out
}

// What the server can actually serve.
const served = new Set()
for (const file of htmlFiles(DIST)) {
  let url = file.replace(/\\/g, "/").slice(DIST.length).replace(/\/index\.html$/, "") || "/"
  served.add(BASE + (url === "/" ? "/" : url))
  served.add(BASE + (url === "/" ? "" : url) + "/")
}

const broken = []
for (const file of htmlFiles(DIST)) {
  let pagePath = file.replace(/\\/g, "/").slice(DIST.length).replace(/\/index\.html$/, "") || "/"
  // GitHub Pages serves directory pages with a trailing slash.
  const pageUrl = new URL(`http://x${BASE}${pagePath === "/" ? "/" : pagePath + "/"}`)
  const html = readFileSync(file, "utf8")
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const raw = match[1]
    if (/^(https?:|mailto:|#|javascript:)/.test(raw)) continue
    const resolved = new URL(raw, pageUrl)
    const path = resolved.pathname
    if (path.startsWith(`${BASE}/_astro/`) || path.startsWith(`${BASE}/pagefind/`)) continue
    if (/\.(png|jpe?g|svg|webp|css|js|xml|json|ico|woff2?)$/.test(path)) continue
    const withSlash = path.endsWith("/") ? path : path + "/"
    if (!served.has(path) && !served.has(withSlash)) {
      broken.push({ page: pageUrl.pathname, href: raw, resolves: path })
    }
  }
}

if (!broken.length) {
  console.log("no broken internal links")
} else {
  process.exitCode = 1
  const byHref = new Map()
  for (const item of broken) {
    const key = `${item.href} -> ${item.resolves}`
    byHref.set(key, (byHref.get(key) || 0) + 1)
  }
  console.log(`${broken.length} broken link(s), ${byHref.size} distinct:\n`)
  for (const [key, count] of [...byHref].sort((a, b) => b[1] - a[1])) {
    console.log(`  x${count}  ${key}`)
  }
  console.log("\npages affected:", [...new Set(broken.map((b) => b.page))].join(", "))
}
