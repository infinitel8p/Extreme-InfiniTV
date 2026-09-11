// Desktop UI mode: mouse drag-to-scroll on the TV home rails (issue #160).
import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const playlistText = readFileSync(join(here, "../visual/fixtures/playlist.m3u"), "utf8")

const RAIL_ITEMS = "#tv-nav [data-tv-nav-item]"
const HOME_RAIL_TRACKS = "[data-tv-view-root] section > div:nth-child(2)"
const VIEWPORT = { width: 1280, height: 720 }

async function mockProvider(page: Page) {
  await page.route("https://fixtures.invalid/**", (route) => {
    const url = route.request().url()
    if (url.includes("playlist.m3u")) {
      return route.fulfill({ status: 200, contentType: "audio/x-mpegurl", body: playlistText })
    }
    if (url.includes("epg.xml")) {
      return route.fulfill({ status: 200, contentType: "application/xml", body: '<?xml version="1.0"?><tv></tv>' })
    }
    return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" })
  })
}

// No favorites/watchlist/continue-watching prefs: those rails stay empty and hidden,
// leaving the "recently added" rail (up to 20 of these movies) as the first visible one.
function seedTvContent() {
  try {
    const movies = Array.from({ length: 24 }, (_, index) => ({
      id: index + 1,
      name: `Movie ${index + 1}`,
      logo: null,
      year: String(2000 + (index % 20)),
      rating: "7.5",
      category: "1",
      plot: "Movie plot.",
      added: 1700000000 - index * 1000,
      tmdb: null,
      genre: "Drama",
    }))
    ;(window as unknown as { __xtTvFixtures: unknown }).__xtTvFixtures = { movies }
  } catch {}
}

async function seedTvState(page: Page, extra: () => void = () => {}) {
  await page.context().addInitScript(() => {
    try {
      localStorage.setItem("xt_ui_mode", "tv")
      localStorage.setItem("xt_receiver_boot", "0")
      localStorage.setItem("xt_locale", "en")
      localStorage.setItem("xt_theme", "dark")
      localStorage.setItem("xt_perf_mode", "1")
      localStorage.setItem(
        "xt_playlists",
        JSON.stringify({
          entries: [
            {
              _id: "fixture",
              type: "m3u",
              url: "https://fixtures.invalid/playlist.m3u",
              title: "Fixture TV",
              addedAt: 1,
              lastUsedAt: 1,
            },
          ],
          selectedId: "fixture",
        })
      )
    } catch {}
  })
  await page.context().addInitScript(extra)
}

async function seedCatalogCache(page: Page) {
  await page.evaluate(async () => {
    const fixtures = (window as unknown as { __xtTvFixtures: any }).__xtTvFixtures
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("xt_cache", 4)
      request.onupgradeneeded = () => {
        const database = request.result
        const store = database.objectStoreNames.contains("entries")
          ? request.transaction!.objectStore("entries")
          : database.createObjectStore("entries")
        if (!store.indexNames.contains("fetchedAt")) store.createIndex("fetchedAt", "fetchedAt")
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const record = (data: unknown) => ({ data, fetchedAt: Date.now(), ttl: 7 * 24 * 60 * 60 * 1000 })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("entries", "readwrite")
      const store = tx.objectStore("entries")
      store.put(record(fixtures.movies), "xt_cache:fixture:vod")
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  })
}

async function waitForHomeRails(page: Page) {
  await page.waitForSelector("[data-tv-view-root] [data-focus-key]")
  const cardCount = () => page.locator("[data-tv-view-root] [data-focus-key]").count()
  await expect
    .poll(async () => {
      const before = await cardCount()
      await page.waitForTimeout(400)
      return (await cardCount()) === before ? before : -1
    })
    .toBeGreaterThan(0)
}

/** First card of the first rail that actually has any (an empty rail stays hidden with no cards). */
function firstRailFocusKey(page: Page) {
  return page.evaluate((selector) => {
    for (const scroller of document.querySelectorAll<HTMLElement>(selector)) {
      const card = scroller.querySelector<HTMLElement>("[data-focus-key]")
      if (card) return card.dataset.focusKey || ""
    }
    return ""
  }, HOME_RAIL_TRACKS)
}

// A few cards in, clear of the left nav rail's hover-expand overlay near the rail's own edge.
function midRailFocusKey(page: Page) {
  return page.evaluate((selector) => {
    for (const scroller of document.querySelectorAll<HTMLElement>(selector)) {
      const cards = Array.from(scroller.querySelectorAll<HTMLElement>("[data-focus-key]"))
      if (cards.length > 3) return cards[3].dataset.focusKey || ""
    }
    return ""
  }, HOME_RAIL_TRACKS)
}

function railTransform(page: Page, focusKey: string) {
  return page.evaluate((key) => {
    const card = document.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)
    const track = card?.parentElement as HTMLElement | null
    return track?.style.transform || ""
  }, focusKey)
}

function translateXPx(transform: string): number {
  const match = transform.match(/translateX\((-?[\d.]+)px\)/)
  return match ? parseFloat(match[1]) : 0
}

function activeFocusInfo(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    const key = active?.dataset.focusKey || ""
    const [railId, , idPart] = key.split(":")
    return { key, railId, index: idPart ? Number(idPart) : -1 }
  })
}

async function setupHomeRails(page: Page) {
  await page.setViewportSize(VIEWPORT)
  await mockProvider(page)
  await seedTvState(page, seedTvContent)
  await page.goto("/tv")
  await page.waitForSelector(RAIL_ITEMS)
  await seedCatalogCache(page)
  await page.goto("/tv")
  await waitForHomeRails(page)
}

test("dragging a home rail scrolls it and snaps focus without navigating", async ({ page }) => {
  await setupHomeRails(page)

  const focusKey = await firstRailFocusKey(page)
  expect(focusKey).not.toBe("")
  await page.evaluate((key) => {
    document.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)?.focus()
  }, focusKey)

  const before = await activeFocusInfo(page)
  const transformBefore = translateXPx(await railTransform(page, focusKey))
  const startPath = new URL(page.url()).pathname

  const card = page.locator(`[data-focus-key="${focusKey}"]`)
  const box = (await card.boundingBox())!
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(startX - (300 * step) / 10, startY, { steps: 1 })
  }
  await page.mouse.up()

  const transformAfter = translateXPx(await railTransform(page, focusKey))
  expect(transformAfter, "the track did not scroll further left after the drag").toBeLessThan(transformBefore)

  const after = await activeFocusInfo(page)
  expect(after.railId, "focus moved out of the dragged rail").toBe(before.railId)
  expect(after.index, "focus did not advance to a later card").toBeGreaterThan(before.index)

  expect(new URL(page.url()).pathname).toBe(startPath)
})

test("a plain click on a rail card still activates it", async ({ page }) => {
  await setupHomeRails(page)

  const focusKey = await midRailFocusKey(page)
  expect(focusKey).not.toBe("")
  const card = page.locator(`[data-focus-key="${focusKey}"]`)
  const beforeUrl = page.url()

  await card.click()
  await page.waitForFunction((prev) => location.href !== prev, beforeUrl)
  expect(page.url()).not.toBe(beforeUrl)
})
