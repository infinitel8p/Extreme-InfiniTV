// Visual-regression suite; Linux baselines only (see visual-regression.yml for how they're built).
import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const playlistText = readFileSync(join(here, "fixtures/playlist.m3u"), "utf8")
const epgText = readFileSync(join(here, "fixtures/epg.xml"), "utf8")

// Minimal 1x1 transparent PNG, reused for every fixture logo.
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
)

const PLAYLIST_ID = "fixture-playlist-tv"
const MOCKED_NOW = "2026-01-15T20:00:00Z"

const ROUTES: Array<{ path: string; slug: string; warmup?: string }> = [
  { path: "/", slug: "home" },
  { path: "/livetv", slug: "livetv" },
  { path: "/movies", slug: "movies" },
  { path: "/series", slug: "series" },
  { path: "/favorites", slug: "favorites" },
  // EPG needs a prior Live TV visit to warm the catalog, else it shows a hint.
  { path: "/epg", slug: "epg", warmup: "/livetv" },
  { path: "/search", slug: "search" },
  { path: "/settings", slug: "settings" },
  { path: "/login", slug: "login" },
]

async function mockFixtureRoutes(page: Page) {
  // Stub GitHub API - /settings fetches the changelog from there.
  await page.context().route("https://api.github.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  })
  await page.context().route("https://fixtures.invalid/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/playlist.m3u") {
      await route.fulfill({ status: 200, contentType: "audio/x-mpegurl", body: playlistText })
      return
    }
    if (url.pathname === "/epg.xml") {
      await route.fulfill({ status: 200, contentType: "application/xml", body: epgText })
      return
    }
    if (url.pathname.startsWith("/logos/")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: LOGO_PNG })
      return
    }
    // /live/* is never actually tuned in these tests - playback never starts.
    await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" })
  })
}

async function seedAppState(page: Page) {
  await page.context().addInitScript(
    ({ playlistId }) => {
      const seed = {
        entries: [
          {
            _id: playlistId,
            title: "Fixture TV",
            type: "m3u",
            url: "https://fixtures.invalid/playlist.m3u",
            addedAt: 1767225600000,
          },
        ],
        selectedId: playlistId,
      }
      try {
        localStorage.setItem("xt_playlists", JSON.stringify(seed))
        localStorage.setItem("xt_theme", "dark")
        localStorage.setItem("xt_perf_mode", "1")
        localStorage.setItem("xt_last_seen_version", "99.0.0")
      } catch {}
      try {
        sessionStorage.setItem("xt_splash_done", "1")
      } catch {}
    },
    { playlistId: PLAYLIST_ID }
  )
}

async function gotoAndSettle(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    active?.blur?.()
  })
}

for (const route of ROUTES) {
  test(`${route.path} matches baseline`, async ({ page }) => {
    // clock.install doesn't freeze time, so hydration timers still fire normally.
    await page.clock.install({ time: new Date(MOCKED_NOW) })
    await mockFixtureRoutes(page)
    await seedAppState(page)
    if (route.warmup) await gotoAndSettle(page, route.warmup)
    await gotoAndSettle(page, route.path)
    await expect(page).toHaveScreenshot(`${route.slug}.png`, { fullPage: false })
  })
}
