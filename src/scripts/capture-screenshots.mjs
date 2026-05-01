// Headless screenshot capture for store listings and the README.
//
// Usage:
//   pnpm dev                            # in another terminal
//   pnpm screenshots                    # capture all devices x all routes
//   pnpm screenshots --device=Desktop
//   pnpm screenshots --route=/livetv
//   pnpm screenshots --theme=light
//
// Credentials come from `.env.screenshots` (gitignored) or env vars:
//   SCREENSHOT_URL=http://localhost:4321
//   XT_TYPE=xtream                       # or "m3u"
//   XT_SERVER_URL=http://provider:8080
//   XT_USERNAME=...
//   XT_PASSWORD=...
//   XT_M3U_URL=https://example.com/playlist.m3u8
//   XT_DISPLAY_NAME=Demo provider        # shown as the playlist title in the sidebar
//   XT_REDACT=false                      # opt out of the in-page redaction pass
//   XT_STATE_FILE=path/to/snapshot.json  # localStorage snapshot to seed (defaults to .screenshot-state.json)
//
// Output: docs/screenshots/<Device>/<route>.png
// When credentials are present, additional welcome-state captures are saved
// alongside the populated ones (e.g. home-welcome.png next to home.png) so
// the empty-state hub can be showcased too.

import { chromium } from "playwright"
import { existsSync, readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "../..")

const DEVICES = {
  Desktop: { width: 1300, height: 850, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  "Desktop-1080p": { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  Chromebook: { width: 1366, height: 768, deviceScaleFactor: 1, isMobile: false, hasTouch: true },
  "Android-TV": { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  "Android-XR": { width: 1920, height: 1080, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
  "iPad-Pro": { width: 1366, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  "iPad-Air": { width: 1180, height: 820, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  "Galaxy-S20-Ultra": { width: 412, height: 915, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true },
}

const ROUTES = ["/", "/livetv", "/movies", "/series", "/epg", "/search", "/downloads", "/settings"]
const WELCOME_ROUTES = ["/"]

function loadDotEnv() {
  const file = path.join(ROOT, ".env.screenshots")
  if (!existsSync(file)) return
  const text = readFileSync(file, "utf8")
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i)
    if (!m) continue
    const key = m[1]
    let val = m[2]
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

function parseArgs(argv) {
  const out = {}
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/)
    if (!m) continue
    out[m[1]] = m[2] ?? "true"
  }
  return out
}

function buildSeed() {
  const type = (process.env.XT_TYPE || "").toLowerCase()
  const id = "screenshot-seed-" + Date.now()
  const displayName = process.env.XT_DISPLAY_NAME || "Demo provider"
  if (type === "m3u") {
    const url = process.env.XT_M3U_URL || ""
    if (!url) return null
    return {
      entries: [{ _id: id, title: displayName, type: "m3u", url, addedAt: Date.now() }],
      selectedId: id,
    }
  }
  const serverUrl = process.env.XT_SERVER_URL || ""
  const username = process.env.XT_USERNAME || ""
  const password = process.env.XT_PASSWORD || ""
  if (!serverUrl || !username || !password) return null
  return {
    entries: [
      {
        _id: id,
        title: displayName,
        type: "xtream",
        serverUrl: serverUrl.replace(/\/+$/, ""),
        username,
        password,
        addedAt: Date.now(),
      },
    ],
    selectedId: id,
  }
}

function loadStateSnapshot() {
  const file = process.env.XT_STATE_FILE
    ? path.resolve(ROOT, process.env.XT_STATE_FILE)
    : path.join(ROOT, ".screenshot-state.json")
  if (!existsSync(file)) return { snapshot: null, file }
  try {
    const text = readFileSync(file, "utf8")
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`State snapshot at ${file} is not a JSON object - ignoring.`)
      return { snapshot: null, file }
    }
    const snapshot = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") snapshot[key] = value
    }
    return { snapshot, file }
  } catch (err) {
    console.warn(`Couldn't parse state snapshot at ${file}: ${err.message}`)
    return { snapshot: null, file }
  }
}

function buildRedactions() {
  const replacements = []
  const add = (raw, replacement) => {
    if (!raw || String(raw).length < 4) return
    replacements.push({ raw: String(raw), replacement })
  }
  const serverUrl = process.env.XT_SERVER_URL || ""
  const m3uUrl = process.env.XT_M3U_URL || ""
  const host = hostnameOf(serverUrl || m3uUrl)
  add(serverUrl.replace(/\/+$/, ""), "https://provider.example")
  add(m3uUrl, "https://provider.example/playlist.m3u8")
  add(host, "provider.example")
  add(process.env.XT_USERNAME, "demo_user")
  add(process.env.XT_PASSWORD, "demo_pass")
  return replacements
}

async function redactPage(page, redactions) {
  if (!redactions || redactions.length === 0) return
  await page.evaluate((items) => {
    const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const patterns = items.map((item) => ({
      regex: new RegExp(escapeRegex(item.raw), "gi"),
      replacement: item.replacement,
    }))
    const redactString = (text) => {
      if (!text) return text
      let out = text
      for (const { regex, replacement } of patterns) out = out.replace(regex, replacement)
      return out
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const before = node.nodeValue
      const after = redactString(before)
      if (before !== after) node.nodeValue = after
    }
    document.querySelectorAll("input, textarea").forEach((field) => {
      if (field.value) field.value = redactString(field.value)
      if (field.placeholder) field.placeholder = redactString(field.placeholder)
    })
    const attrs = ["title", "aria-label", "alt", "href", "data-href", "data-url"]
    for (const attr of attrs) {
      document.querySelectorAll(`[${attr}]`).forEach((el) => {
        const value = el.getAttribute(attr)
        if (!value) return
        const next = redactString(value)
        if (next !== value) el.setAttribute(attr, next)
      })
    }
  }, redactions)
}

function hostnameOf(u) {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : "http://" + u).hostname
  } catch {
    return ""
  }
}

function slugRoute(route) {
  if (route === "/") return "home"
  return route.replace(/^\/+/, "").replace(/\//g, "-")
}

async function reachable(url) {
  try {
    const res = await fetch(url, { method: "GET" })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

async function captureForDevice(browser, deviceName, viewport, routes, baseUrl, seed, theme, slugSuffix = "", redactions = [], snapshot = null, displayName = "Demo provider") {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
    colorScheme: theme === "light" ? "light" : "dark",
  })

  await context.addInitScript(({ seed, theme, snapshot, displayName }) => {
    try {
      if (snapshot) {
        for (const [key, value] of Object.entries(snapshot)) {
          try { localStorage.setItem(key, value) } catch {}
        }
        try {
          const raw = localStorage.getItem("xt_playlists")
          if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed && Array.isArray(parsed.entries)) {
              for (const entry of parsed.entries) {
                if (entry && typeof entry === "object") entry.title = displayName
              }
              localStorage.setItem("xt_playlists", JSON.stringify(parsed))
            }
          }
        } catch {}
      } else if (seed) {
        localStorage.setItem("xt_playlists", JSON.stringify(seed))
      }
      localStorage.setItem("xt_theme", theme)
    } catch {}
  }, { seed, theme, snapshot, displayName })

  const page = await context.newPage()

  for (const route of routes) {
    const target = baseUrl.replace(/\/+$/, "") + route
    try {
      await page.goto(target, { waitUntil: "networkidle", timeout: 30_000 })
    } catch {
      try {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 })
      } catch (err) {
        console.error(`  x ${deviceName}${route} - navigation failed: ${err.message}`)
        continue
      }
    }
    await page.waitForTimeout(1500)
    try {
      await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur())
    } catch {}
    try {
      await redactPage(page, redactions)
    } catch (err) {
      console.warn(`  ! ${deviceName}${route} - redaction pass failed: ${err.message}`)
    }

    const outDir = path.join(ROOT, "docs", "screenshots", deviceName)
    await mkdir(outDir, { recursive: true })
    const file = path.join(outDir, `${slugRoute(route)}${slugSuffix}.png`)
    await page.screenshot({ path: file, fullPage: false })
    console.log(`  ok ${path.relative(ROOT, file)}`)
  }

  await context.close()
}

async function main() {
  loadDotEnv()
  const args = parseArgs(process.argv)
  const baseUrl = args.url || process.env.SCREENSHOT_URL || "http://localhost:4321"
  const theme = args.theme === "light" ? "light" : "dark"

  if (!(await reachable(baseUrl))) {
    console.error(`Cannot reach ${baseUrl}. Start the dev server with 'pnpm dev' (or pass --url=...).`)
    process.exit(1)
  }

  const deviceFilter = args.device
  const routeFilter = args.route
  const devices = Object.entries(DEVICES).filter(([name]) => !deviceFilter || name.toLowerCase() === deviceFilter.toLowerCase())
  const routes = ROUTES.filter((r) => !routeFilter || r === routeFilter)
  if (devices.length === 0) {
    console.error(`No device matched --device=${deviceFilter}. Known: ${Object.keys(DEVICES).join(", ")}`)
    process.exit(1)
  }
  if (routes.length === 0) {
    console.error(`No route matched --route=${routeFilter}. Known: ${ROUTES.join(", ")}`)
    process.exit(1)
  }

  const seed = buildSeed()
  const { snapshot, file: stateFile } = loadStateSnapshot()
  const displayName = process.env.XT_DISPLAY_NAME || "Demo provider"

  if (snapshot) {
    console.log(`Loaded localStorage snapshot from ${path.relative(ROOT, stateFile)} (${Object.keys(snapshot).length} keys). Playlist title forced to "${displayName}".`)
    if (snapshot.xt_playlists) {
      try {
        const parsed = JSON.parse(snapshot.xt_playlists)
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
        for (const entry of entries) {
          if (entry?.serverUrl && !process.env.XT_SERVER_URL) process.env.XT_SERVER_URL = entry.serverUrl
          if (entry?.url && !process.env.XT_M3U_URL) process.env.XT_M3U_URL = entry.url
          if (entry?.username && !process.env.XT_USERNAME) process.env.XT_USERNAME = entry.username
          if (entry?.password && !process.env.XT_PASSWORD) process.env.XT_PASSWORD = entry.password
        }
      } catch {}
    }
  } else if (!seed) {
    console.warn("No XT_* credentials, no .screenshot-state.json - screenshots will show the empty/login state.")
  }

  const hasState = Boolean(snapshot || seed)
  const welcomeRoutes = hasState ? WELCOME_ROUTES.filter((route) => !routeFilter || route === routeFilter) : []
  const redactionsEnabled = args.redact !== "false" && process.env.XT_REDACT !== "false"
  const redactions = redactionsEnabled ? buildRedactions() : []

  console.log(`Capturing ${devices.length} device(s) x ${routes.length} route(s) at ${baseUrl} (theme: ${theme})`)
  if (welcomeRoutes.length > 0) {
    console.log(`Plus welcome state for: ${welcomeRoutes.join(", ")} (saved with -welcome suffix)`)
  }
  if (redactions.length > 0) {
    console.log(`Redacting ${redactions.length} secret(s) from each screenshot (host / username / password / playlist URL).`)
  } else if (!redactionsEnabled) {
    console.log("Redaction disabled (--redact=false or XT_REDACT=false).")
  }
  const browser = await chromium.launch()
  try {
    for (const [name, viewport] of devices) {
      console.log(`> ${name} (${viewport.width}x${viewport.height})`)
      await captureForDevice(browser, name, viewport, routes, baseUrl, seed, theme, "", redactions, snapshot, displayName)
      if (welcomeRoutes.length > 0) {
        await captureForDevice(browser, name, viewport, welcomeRoutes, baseUrl, null, theme, "-welcome", redactions, null, displayName)
      }
    }
  } finally {
    await browser.close()
  }
  console.log("Done.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
