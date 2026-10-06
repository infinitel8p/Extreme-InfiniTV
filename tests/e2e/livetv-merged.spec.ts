// Merged catalogs (#164): two M3U playlists sharing one /livetv list, channel ids colliding on purpose.
import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const playlistA = readFileSync(join(here, "../visual/fixtures/playlist.m3u"), "utf8")

const PLAYLIST_A = "pl-a"
const PLAYLIST_B = "pl-b"

const HLS_MANIFEST = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:10", "#EXTINF:10,", "https://fixtures.invalid/seg0.ts", "#EXT-X-ENDLIST", ""].join("\n")

const playlistB = [
  '#EXTM3U x-tvg-url="https://fixtures-b.invalid/epg.xml"',
  '#EXTINF:-1 tvg-id="b-news" group-title="News",Beta News',
  "https://fixtures-b.invalid/live/1.m3u8",
  '#EXTINF:-1 tvg-id="b-docs" group-title="Docs",Beta Docs',
  "https://fixtures-b.invalid/live/2.m3u8",
  "",
].join("\n")

function xmltvFor(tvgId: string): string {
  const hourMs = 60 * 60 * 1000
  const start = new Date(Math.floor(Date.now() / hourMs) * hourMs - hourMs)
  const stop = new Date(start.getTime() + 3 * hourMs)
  const stamp = (date: Date) => date.toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000"
  return (
    `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="${tvgId}"><display-name>${tvgId}</display-name></channel>` +
    `<programme start="${stamp(start)}" stop="${stamp(stop)}" channel="${tvgId}"><title>Live Block</title></programme></tv>`
  )
}

function m3uEntry(id: string, url: string, title: string, mergedVisible: boolean) {
  return { _id: id, type: "m3u", url, title, addedAt: 1, lastUsedAt: 1, ...(mergedVisible ? { mergedVisible: true } : {}) }
}

async function seed(page: Page, options: { mergeB: boolean }): Promise<void> {
  const state = {
    entries: [
      m3uEntry(PLAYLIST_A, "https://fixtures.invalid/playlist.m3u", "Fixture A", false),
      m3uEntry(PLAYLIST_B, "https://fixtures-b.invalid/playlist.m3u", "Fixture B", options.mergeB),
    ],
    selectedId: PLAYLIST_A,
  }
  await page.context().addInitScript((playlists) => {
    try {
      localStorage.setItem("xt_locale", "en")
      localStorage.setItem("xt_theme", "dark")
      localStorage.setItem("xt_perf_mode", "1")
      localStorage.setItem("xt_last_seen_version", "99.0.0")
      if (!localStorage.getItem("xt_playlists")) localStorage.setItem("xt_playlists", JSON.stringify(playlists))
    } catch {}
    try {
      sessionStorage.setItem("xt_splash_done", "1")
    } catch {}
  }, state)

  await page.context().route("https://api.github.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  )
  await page.context().route(/^https:\/\/fixtures(-b)?\.invalid\//, (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/playlist.m3u") {
      return route.fulfill({
        status: 200,
        contentType: "audio/x-mpegurl",
        body: url.hostname.startsWith("fixtures-b") ? playlistB : playlistA,
      })
    }
    if (url.pathname === "/epg.xml") {
      const tvgId = url.hostname.startsWith("fixtures-b") ? "b-news" : "news-one"
      return route.fulfill({ status: 200, contentType: "application/xml", body: xmltvFor(tvgId) })
    }
    if (/^\/live\/\d+\.m3u8$/.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: "application/vnd.apple.mpegurl", body: HLS_MANIFEST })
    }
    if (url.pathname === "/seg0.ts") {
      return route.fulfill({ status: 200, contentType: "video/mp2t", body: Buffer.from([0]) })
    }
    return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" })
  })
}

const rows = (page: Page) => page.locator(".channel-row")

test("merged list shows both playlists and plays a row from its own host", async ({ page }) => {
  await seed(page, { mergeB: true })
  await page.goto("/livetv")

  await expect(rows(page)).toHaveCount(11)

  await page.locator("#category-picker-trigger").click()
  const options = page.locator('#category-picker-list [role="option"]')
  await expect(options.filter({ hasText: "News · Fixture B" })).toHaveCount(1)
  await expect(options.filter({ hasText: "News · Fixture A" })).toHaveCount(1)
  await options.filter({ hasText: "News · Fixture B" }).click()

  await expect(rows(page)).toHaveCount(1)
  const manifestRequest = page.waitForRequest("https://fixtures-b.invalid/live/1.m3u8")
  await rows(page).first().locator('button[data-role="play"]').click()
  await manifestRequest
  await expect(page.locator("#current")).toContainText("Beta News")
})

test("deep link with pl autoplays that playlist's channel", async ({ page }) => {
  await seed(page, { mergeB: true })
  const manifestRequest = page.waitForRequest("https://fixtures-b.invalid/live/1.m3u8")
  await page.goto(`/livetv?channel=1&pl=${PLAYLIST_B}`)
  await manifestRequest
  await expect(page.locator("#current")).toContainText("Beta News")
})

test("without a merge flag the list is the single active playlist", async ({ page }) => {
  await seed(page, { mergeB: false })
  await page.goto("/livetv")

  await expect(rows(page)).toHaveCount(9)
  await page.locator("#category-picker-trigger").click()
  const options = page.locator('#category-picker-list [role="option"]')
  await expect(options.filter({ hasText: "·" })).toHaveCount(0)
})

test("merged guide lists channels from both playlists", async ({ page }) => {
  await seed(page, { mergeB: true })
  await page.goto("/epg")

  await expect(page.locator("#epg-body .epg-row")).toHaveCount(11)
})
