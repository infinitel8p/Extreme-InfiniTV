// TV focus memory: a stored focus key may only be restored on a Back navigation, never on a forward one.
import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const playlistText = readFileSync(join(here, "../visual/fixtures/playlist.m3u"), "utf8")

const RAIL_ITEMS = "#tv-nav [data-tv-nav-item]"
const SERIES_COUNT = 300

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

async function seedTvState(page: Page) {
  await page.context().addInitScript(() => {
    try {
      localStorage.setItem("xt_force_tv", "1")
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
}

async function seedSeriesGridCache(page: Page, count: number) {
  await page.evaluate(async (total) => {
    const poster =
      "data:image/svg+xml;base64," +
      btoa('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#334"/></svg>')
    const shows = Array.from({ length: total }, (_, index) => ({
      id: 2000 + index,
      name: `Grid Show ${index + 1}`,
      logo: poster,
      year: String(2000 + (index % 20)),
      rating: "6.0",
      category: "Drama",
      added: 1700000000 - index,
      tmdb: null,
      genre: "Drama",
    }))
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
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("entries", "readwrite")
      tx.objectStore("entries").put(
        { data: shows, fetchedAt: Date.now(), ttl: 7 * 24 * 60 * 60 * 1000 },
        "xt_cache:fixture:series"
      )
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }, count)
}

function gridGeometry(page: Page) {
  return page.evaluate(() => {
    const row0 = document.querySelector<HTMLElement>('[data-grid-row="0"]')
    const track = row0?.parentElement || null
    const scroller = track?.parentElement || null
    const active = document.activeElement
    const activeCard = active instanceof HTMLElement ? active.closest<HTMLElement>("[data-grid-index]") : null
    const scrollerRect = scroller?.getBoundingClientRect()
    return {
      transform: track?.style.transform || "",
      row0Top: row0 ? Math.round(row0.getBoundingClientRect().top) : null,
      contentTop:
        scroller && scrollerRect
          ? Math.round(scrollerRect.top + (parseFloat(getComputedStyle(scroller).paddingTop) || 0))
          : null,
      contentBottom: scrollerRect ? Math.round(scrollerRect.bottom) : null,
      activeIndex: activeCard?.dataset.gridIndex ?? null,
      activeKey: activeCard?.dataset.focusKey ?? null,
      activeTop: activeCard ? Math.round(activeCard.getBoundingClientRect().top) : null,
      columns: document.querySelectorAll('[data-grid-row="0"] [data-grid-index]').length,
      storedKey: sessionStorage.getItem("xt_tv_focus:/tv/series") || "",
    }
  })
}

async function railInto(page: Page, href: string) {
  await page.evaluate((target) => {
    document.querySelector<HTMLAnchorElement>(`#tv-nav a[href="${target}"]`)?.click()
  }, href)
  await page.waitForFunction((target) => location.pathname.replace(/[/]$/, "") === target, href)
}

async function openSeriesGrid(page: Page) {
  await mockProvider(page)
  await seedTvState(page)
  await page.goto("/tv")
  await page.waitForSelector(RAIL_ITEMS)
  await seedSeriesGridCache(page, SERIES_COUNT)
  await page.goto("/tv")
  await page.waitForSelector(RAIL_ITEMS)
}

const VIEWPORTS = [
  { width: 1191, height: 900 },
  { width: 1920, height: 1080 },
]

for (const viewport of VIEWPORTS) {
  const label = `${viewport.width}x${viewport.height}`

  test(`forward rail navigation into the series grid ignores a stored row (${label})`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openSeriesGrid(page)

    await railInto(page, "/tv/series")
    await page.waitForSelector('[data-grid-row="1"]')
    await page.waitForTimeout(1500)

    await page.keyboard.press("ArrowDown")
    await page.waitForTimeout(400)
    const afterDown = await gridGeometry(page)
    expect(Number(afterDown.activeIndex), "ArrowDown did not land on row 1").toBeGreaterThanOrEqual(
      afterDown.columns
    )

    await railInto(page, "/tv")
    await page.waitForTimeout(900)
    await railInto(page, "/tv/series")
    await page.waitForSelector('[data-grid-row="1"]')
    await page.waitForTimeout(1500)

    const grid = await gridGeometry(page)
    expect(grid.columns).toBeGreaterThan(1)
    expect(grid.activeIndex, "a forward visit must open on the first card").toBe("0")
    expect(grid.transform, "a forward visit must open unscrolled").toMatch(/translateY\(0px\)|^$/)
    expect(grid.row0Top, "row 0 is clipped above the grid").toBeGreaterThanOrEqual((grid.contentTop || 0) - 1)
  })

  test(`Back from a detail page restores the row-1 card (${label})`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openSeriesGrid(page)

    await railInto(page, "/tv/series")
    await page.waitForSelector('[data-grid-row="1"]')
    await page.waitForTimeout(1500)

    await page.keyboard.press("ArrowDown")
    await page.waitForTimeout(400)
    const before = await gridGeometry(page)
    const restoredKey = before.activeKey || ""
    expect(restoredKey, "no grid card was focused before entering the detail page").not.toBe("")

    await page.keyboard.press("Enter")
    await page.waitForFunction(() => location.pathname.replace(/[/]$/, "") === "/tv/series/detail")
    await page.waitForTimeout(1200)

    await page.goBack()
    await page.waitForSelector('[data-grid-row="1"]')
    await page.waitForTimeout(1800)

    const grid = await gridGeometry(page)
    expect(grid.activeKey, "Back did not restore the card the user left from").toBe(restoredKey)
    expect(grid.activeTop).toBeGreaterThanOrEqual((grid.contentTop || 0) - 1)
    expect(grid.activeTop).toBeLessThan(grid.contentBottom || 0)
  })
}
