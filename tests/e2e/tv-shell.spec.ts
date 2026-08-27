// TV shell: the rail owns its own spatial-nav section, focus restore survives async views,
// and runtime <html> attributes survive a ClientRouter swap.
import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const playlistText = readFileSync(join(here, "../visual/fixtures/playlist.m3u"), "utf8")

const RAIL_ITEMS = "#tv-nav [data-tv-nav-item]"
const SETTINGS_ROWS = "#tv-settings-rows [data-focus-key]"
const CHANNEL_ROWS = '[data-focus-key^="ch:"]'

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

async function seedTvState(page: Page, extra: () => void = () => {}) {
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
  await page.context().addInitScript(extra)
}

const TV_VIEWPORT = { width: 1920, height: 1080 }
const HOME_RAIL_TRACKS = "[data-tv-view-root] section > div:nth-child(2)"

// Home rails + a 4-season series detail need cached catalogs and per-playlist prefs.
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
    const shows = Array.from({ length: 8 }, (_, index) => ({
      id: 101 + index,
      name: `Show ${index + 1}`,
      logo: null,
      year: String(2010 + index),
      rating: "8.1",
      category: "1",
      plot: "Show plot.",
      added: 1700000000 - index * 2000,
      tmdb: null,
      genre: "Drama",
    }))
    const episodes: Record<string, unknown[]> = {}
    let episodeId = 101000
    for (let season = 1; season <= 4; season++) {
      episodes[String(season)] = Array.from({ length: 8 }, (_, index) => ({
        id: String(++episodeId),
        episode_num: index + 1,
        title: `S${season} Episode ${index + 1}`,
        container_extension: "mp4",
        season,
        info: { duration: "00:42:00", duration_secs: 2520, plot: "Episode plot." },
      }))
    }
    const seriesInfo = {
      info: {
        name: "Show 1",
        cover: null,
        plot: "A long series description that keeps wrapping past four lines in the TV hero band. ".repeat(6),
        genre: "Drama, Mystery",
        releaseDate: "2015-03-01",
        rating: "8.4",
      },
      seasons: [{ season_number: 1 }, { season_number: 2 }, { season_number: 3 }, { season_number: 4 }],
      episodes,
    }

    localStorage.setItem(
      "xt_prefs",
      JSON.stringify({
        fixture: {
          favLive: [1, 2, 3],
          favVod: [1, 2, 3, 4],
          favSeries: [101],
          watchVod: { 6: { ts: 1700000000000, name: "Movie 6" } },
          watchSeries: { 103: { ts: 1700000500000, name: "Show 3" } },
          progVod: { 8: { position: 600, duration: 5400, ts: 1700000600000, name: "Movie 8" } },
        },
      })
    )
    ;(window as unknown as { __xtTvFixtures: unknown }).__xtTvFixtures = { movies, shows, seriesInfo }
  } catch {}
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
      store.put(record(fixtures.shows), "xt_cache:fixture:series")
      store.put(record(fixtures.seriesInfo), "xt_cache:fixture:series_info_101")
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  })
}

// Rails rebuild on catalog / EPG events; assertions must run after the card set settles.
async function waitForHomeRails(page: Page) {
  await page.waitForSelector("[data-tv-view-root] [data-focus-key]")
  const cardCount = () => page.locator("[data-tv-view-root] [data-focus-key]").count()
  await expect.poll(async () => {
    const before = await cardCount()
    await page.waitForTimeout(400)
    return (await cardCount()) === before ? before : -1
  }).toBeGreaterThan(0)
}

function focusByKey(page: Page, focusKey: string) {
  return page.evaluate((key) => {
    document.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)?.focus()
  }, focusKey)
}

/** First card of every home rail, keyed off the `<railId>:<kind>:<id>` focus keys. */
function railFirstCardKeys(page: Page) {
  return page.evaluate((selector) => {
    const seenRails = new Set<string>()
    const keys: string[] = []
    for (const scroller of document.querySelectorAll<HTMLElement>(selector)) {
      const card = scroller.firstElementChild?.querySelector<HTMLElement>("[data-focus-key]")
      const key = card?.dataset.focusKey || ""
      const railId = key.split(":")[0]
      if (!railId || seenRails.has(railId)) continue
      seenRails.add(railId)
      keys.push(key)
    }
    return keys
  }, HOME_RAIL_TRACKS)
}

function focusRailItem(page: Page, index: number) {
  return page.evaluate((at) => {
    document.querySelectorAll<HTMLElement>("#tv-nav [data-tv-nav-item]")[at]?.focus()
  }, index)
}

function activeIsInRail(page: Page) {
  return page.evaluate(() => ({
    inRail: !!document.activeElement?.closest("#tv-nav"),
    label: document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName || "",
  }))
}

test("D-pad Up/Down stays inside the TV nav rail", async ({ page }) => {
  await mockProvider(page)
  await seedTvState(page)
  await page.goto("/tv/settings")
  await page.waitForSelector(SETTINGS_ROWS)

  const railCount = await page.locator(RAIL_ITEMS).count()
  expect(railCount).toBeGreaterThan(2)

  for (let index = 0; index < railCount; index++) {
    for (const key of ["ArrowDown", "ArrowUp"] as const) {
      await focusRailItem(page, index)
      await page.keyboard.press(key)
      const after = await activeIsInRail(page)
      expect(after.inRail, `${key} from rail item ${index} left the rail (-> ${after.label})`).toBe(true)
    }
  }
})

test("Right leaves the rail into the page, Left returns to the rail", async ({ page }) => {
  await mockProvider(page)
  await seedTvState(page)
  await page.goto("/tv/settings")
  await page.waitForSelector(SETTINGS_ROWS)

  await focusRailItem(page, 0)
  await page.keyboard.press("ArrowRight")
  expect((await activeIsInRail(page)).inRail).toBe(false)

  await page.keyboard.press("ArrowLeft")
  expect((await activeIsInRail(page)).inRail).toBe(true)
})

test("focus restore waits for an asynchronously populated view", async ({ page }) => {
  await mockProvider(page)
  await seedTvState(page, () => {
    try {
      sessionStorage.setItem("xt_tv_focus:/tv/live", "ch:4")
    } catch {}
  })

  await page.goto("/tv/live")
  await expect(page.locator('[data-focus-key="ch:4"]')).toBeFocused({ timeout: 5000 })
  expect(await page.locator(CHANNEL_ROWS).count()).toBeGreaterThan(4)
})

test("runtime <html> attributes survive a ClientRouter swap", async ({ page }) => {
  await mockProvider(page)
  await seedTvState(page)
  await page.goto("/tv")
  await page.waitForSelector(RAIL_ITEMS)

  const before = await page.evaluate(() => ({
    fontSize: getComputedStyle(document.documentElement).fontSize,
    tvUi: document.documentElement.dataset.tvUi,
    perfMode: document.documentElement.getAttribute("data-perf-mode"),
  }))

  await page.evaluate(() => {
    document.querySelector<HTMLAnchorElement>('#tv-nav a[href="/tv/settings"]')?.click()
  })
  await page.waitForFunction(() => location.pathname.replace(/\/$/, "") === "/tv/settings")
  await page.waitForSelector(SETTINGS_ROWS)

  const after = await page.evaluate(() => ({
    fontSize: getComputedStyle(document.documentElement).fontSize,
    tvUi: document.documentElement.dataset.tvUi,
    perfMode: document.documentElement.getAttribute("data-perf-mode"),
  }))

  expect(after).toEqual(before)
  expect(after.tvUi).toBe("1")
})

test("Left reaches the nav rail from a home rail's first card", async ({ page }) => {
  await page.setViewportSize(TV_VIEWPORT)
  await mockProvider(page)
  await seedTvState(page, seedTvContent)
  await page.goto("/tv")
  await page.waitForSelector(RAIL_ITEMS)
  await seedCatalogCache(page)
  await page.goto("/tv")
  await waitForHomeRails(page)

  const firstCardKeys = await railFirstCardKeys(page)
  expect(firstCardKeys.length).toBeGreaterThan(1)

  for (const focusKey of firstCardKeys) {
    await focusByKey(page, focusKey)
    await page.keyboard.press("ArrowLeft")
    const after = await activeIsInRail(page)
    expect(after.inRail, `Left from ${focusKey} did not reach the nav (-> ${after.label})`).toBe(true)
  }
})

test("Left reaches the nav rail from a settings row", async ({ page }) => {
  await page.setViewportSize(TV_VIEWPORT)
  await mockProvider(page)
  await seedTvState(page)
  await page.goto("/tv/settings")
  await page.waitForSelector(SETTINGS_ROWS)

  await page.locator(SETTINGS_ROWS).first().focus()
  await page.keyboard.press("ArrowLeft")
  expect((await activeIsInRail(page)).inRail).toBe(true)
})

test("a rail's first card rests at translate 0 when entered", async ({ page }) => {
  await page.setViewportSize(TV_VIEWPORT)
  await mockProvider(page)
  await seedTvState(page, seedTvContent)
  await page.goto("/tv")
  await page.waitForSelector(RAIL_ITEMS)
  await seedCatalogCache(page)
  await page.goto("/tv")
  await waitForHomeRails(page)

  const firstCardKeys = await railFirstCardKeys(page)
  expect(firstCardKeys.length).toBeGreaterThan(1)

  for (const focusKey of firstCardKeys) {
    await focusByKey(page, focusKey)
    const resting = await page.evaluate((key) => {
      const card = document.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)!
      const track = card.parentElement!
      const scroller = track.parentElement!
      const trackPad = parseFloat(getComputedStyle(track).paddingLeft) || 0
      return {
        transform: track.style.transform,
        cardLeft: Math.round(card.getBoundingClientRect().left),
        contentLeft: Math.round(scroller.getBoundingClientRect().left + trackPad),
      }
    }, focusKey)
    expect(resting.transform, `rail ${focusKey} was translated on entry`).toMatch(/translateX\(0px\)|^$/)
    expect(resting.cardLeft, `rail ${focusKey} first card is clipped`).toBe(resting.contentLeft)
  }
})

test("Up from an episode row back to the actions brings the hero title into view", async ({ page }) => {
  await page.setViewportSize({ width: 1437, height: 909 })
  await mockProvider(page)
  await seedTvState(page, seedTvContent)
  await page.goto("/tv")
  await page.waitForSelector(RAIL_ITEMS)
  await seedCatalogCache(page)

  await page.goto("/tv/series/detail?id=101")
  await page.waitForSelector('[data-focus-key^="ep:"]')
  await expect(page.locator('[data-focus-key="action:play"]')).toBeFocused({ timeout: 5000 })

  await focusByKey(page, "ep:1:5")
  await expect
    .poll(() => page.evaluate(() => {
      const title = document.querySelector<HTMLElement>("[data-tv-view-root] h1")!
      return Math.round(title.getBoundingClientRect().bottom)
    }))
    .toBeLessThan(0)

  for (let step = 0; step < 8; step++) {
    await page.keyboard.press("ArrowUp")
    const focusKey = await page.evaluate(() => document.activeElement?.getAttribute("data-focus-key") || "")
    if (focusKey === "action:play") break
  }

  const heroVisible = await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>("[data-tv-view-root] h1")!
    const rect = title.getBoundingClientRect()
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), viewport: window.innerHeight }
  })
  expect(heroVisible.top).toBeGreaterThanOrEqual(0)
  expect(heroVisible.bottom).toBeLessThanOrEqual(heroVisible.viewport)
})
