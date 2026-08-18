// EPG times are generated relative to real "now": Playwright's page.clock doesn't reach
// epg-worker.ts's Web Worker, so a date-pinned fixture would get window-filtered out there.
import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const playlistText = readFileSync(join(here, "../visual/fixtures/playlist.m3u"), "utf8")

// Minimal 1x1 transparent PNG, reused for every fixture logo.
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
)

// One 10s segment is enough to trigger a manifest + segment request; we never assert decoded frames.
const HLS_MANIFEST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:10",
  "#EXTINF:10,",
  "https://fixtures.invalid/seg0.ts",
  "#EXT-X-ENDLIST",
  "",
].join("\n")

const FIRST_CHANNEL_NAME = "News One"
const LIVE_PROGRAMME_TITLE = "Evening News"

// Same 9 channels as tests/visual/fixtures/playlist.m3u, in file order.
const FIXTURE_CHANNELS = [
  { tvgId: "news-one", name: "News One" },
  { tvgId: "news-two", name: "News Two" },
  { tvgId: "sports-prime", name: "Sports Prime" },
  { tvgId: "sports-extra", name: "Sports Extra" },
  { tvgId: "sports-plus", name: "Sports Plus" },
  { tvgId: "drama-central", name: "Drama Central" },
  { tvgId: "comedy-house", name: "Comedy House" },
  { tvgId: "movie-channel", name: "Movie Channel" },
  { tvgId: "kids-zone", name: "Kids Zone" },
]

function xmltvTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
  )
}

/**
 * Hourly programme blocks per channel spanning now-2h..now+4h (inside both the EPG grid's 6h
 * window and epg-worker.ts's rolling filter); the block containing "now" is LIVE_PROGRAMME_TITLE.
 */
function buildEpgFixture(): string {
  const hourMs = 60 * 60 * 1000
  const anchor = new Date(Math.floor(Date.now() / hourMs) * hourMs - 2 * hourMs)
  const blockCount = 6

  const channelElements = FIXTURE_CHANNELS.map(
    (channel) => `  <channel id="${channel.tvgId}"><display-name>${channel.name}</display-name></channel>`
  )

  const programmeElements: string[] = []
  for (const channel of FIXTURE_CHANNELS) {
    for (let blockIdx = 0; blockIdx < blockCount; blockIdx++) {
      const start = new Date(anchor.getTime() + blockIdx * hourMs)
      const stop = new Date(start.getTime() + hourMs)
      const title = blockIdx === 2 ? LIVE_PROGRAMME_TITLE : `Programme ${blockIdx + 1}`
      programmeElements.push(
        `  <programme start="${xmltvTimestamp(start)}" stop="${xmltvTimestamp(stop)}" channel="${channel.tvgId}">` +
          `<title>${title}</title><desc>Fixture programme for e2e coverage.</desc></programme>`
      )
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${channelElements.join("\n")}\n${programmeElements.join("\n")}\n</tv>\n`
}

async function mockFixtureRoutes(page: Page, epgText: string) {
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
    if (/^\/live\/\d+\.m3u8$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: "application/vnd.apple.mpegurl",
        body: HLS_MANIFEST,
      })
      return
    }
    if (url.pathname === "/seg0.ts") {
      await route.fulfill({ status: 200, contentType: "video/mp2t", body: Buffer.from([0]) })
      return
    }
    await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" })
  })
}

async function seedAppState(page: Page) {
  // Deliberately doesn't seed xt_playlists; this spec exercises the real /login flow that creates it.
  await page.context().addInitScript(() => {
    try {
      localStorage.setItem("xt_theme", "dark")
      localStorage.setItem("xt_perf_mode", "1")
      localStorage.setItem("xt_last_seen_version", "99.0.0")
    } catch {}
    try {
      sessionStorage.setItem("xt_splash_done", "1")
    } catch {}
  })
}

test("login -> live TV -> play a channel -> open EPG", async ({ page }) => {
  await mockFixtureRoutes(page, buildEpgFixture())
  await seedAppState(page)

  await page.goto("/login")
  await page.locator("#tab-m3u").click()
  await page.locator("#m3uUrl").fill("https://fixtures.invalid/playlist.m3u")
  await page.locator("#title").fill("Fixture TV")

  await page.locator("#testBtn").click()
  const statusEl = page.locator("#status")
  await expect(statusEl).toBeVisible()
  await expect(statusEl).toContainText(/9 entries/i)

  await Promise.all([
    page.waitForURL("**/livetv"),
    page.locator("#saveBtn").click(),
  ])

  const channelRows = page.locator(".channel-row")
  await expect(channelRows).toHaveCount(9)

  const firstRow = page.locator('.channel-row[data-idx="0"]')
  await expect(firstRow).toContainText(FIRST_CHANNEL_NAME)

  const manifestRequest = page.waitForRequest(/\/live\/1\.m3u8$/)
  await firstRow.locator('button[data-role="play"]').click()
  await manifestRequest

  await expect(firstRow).toHaveAttribute("data-now-playing", "true")
  await expect(page.locator("#current")).toContainText(FIRST_CHANNEL_NAME)
  await expect
    .poll(() => page.locator("#player").evaluate((el) => el.hasAttribute("hidden")))
    .toBe(false)

  await Promise.all([
    page.waitForURL("**/epg"),
    page.locator('.sidebar-rail a[href="/epg"]').click(),
  ])

  await expect(page.locator("#epg-grid")).not.toHaveClass(/hidden/)
  await expect(page.locator("#epg-status")).toHaveClass(/hidden/)
  await expect(page.locator("#epg-body .epg-row")).toHaveCount(9)
  await expect(page.locator("#epg-time-header-inner")).not.toBeEmpty()

  const liveProgramme = page.locator(`.epg-cell[title*="${LIVE_PROGRAMME_TITLE}"]`).first()
  await expect(liveProgramme).toBeVisible()
})
