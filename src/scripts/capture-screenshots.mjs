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
//
// Output: docs/screenshots/<Device>/<route>.png

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
  "Android-XR": { width: 1032, height: 1104, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
  "iPad-Pro": { width: 1024, height: 1366, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  "iPad-Air": { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  "Galaxy-S20-Ultra": { width: 412, height: 915, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true },
}

const ROUTES = ["/", "/livetv", "/movies", "/series", "/epg", "/settings"]

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
  if (type === "m3u") {
    const url = process.env.XT_M3U_URL || ""
    if (!url) return null
    return {
      entries: [{ _id: id, title: hostnameOf(url) || "Demo M3U", type: "m3u", url, addedAt: Date.now() }],
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
        title: hostnameOf(serverUrl) || "Demo provider",
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

async function captureForDevice(browser, deviceName, viewport, routes, baseUrl, seed, theme) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
    colorScheme: theme === "light" ? "light" : "dark",
  })

  await context.addInitScript(({ seed, theme }) => {
    try {
      if (seed) {
        localStorage.setItem("xt_playlists", JSON.stringify(seed))
      }
      localStorage.setItem("xt_theme", theme)
    } catch {}
  }, { seed, theme })

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

    const outDir = path.join(ROOT, "docs", "screenshots", deviceName)
    await mkdir(outDir, { recursive: true })
    const file = path.join(outDir, `${slugRoute(route)}.png`)
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
  if (!seed) {
    console.warn("No XT_* credentials in env or .env.screenshots - screenshots will show the empty/login state.")
  }

  console.log(`Capturing ${devices.length} device(s) x ${routes.length} route(s) at ${baseUrl} (theme: ${theme})`)
  const browser = await chromium.launch()
  try {
    for (const [name, viewport] of devices) {
      console.log(`> ${name} (${viewport.width}x${viewport.height})`)
      await captureForDevice(browser, name, viewport, routes, baseUrl, seed, theme)
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
