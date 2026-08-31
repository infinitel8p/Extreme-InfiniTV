// TV 60rem-canvas layout: verifies the viewport-relative root scaling (tv.css) keeps every
// /tv/* view free of horizontal overflow and correctly sized at the real Android TV viewport
// (960x540 @2x), plus two desktop-testing viewports that share the same 16:9 canvas.
import { test, expect, type Page } from "@playwright/test"
import { tmpdir } from "node:os"
import { join } from "node:path"

const RAIL_ITEMS = "#tv-nav [data-tv-nav-item]"
const HOME_RAIL_TRACKS = "[data-tv-view-root] section > div:nth-child(2)"
const MOVIE_COUNT = 300
const SERIES_COUNT = 30
const DETAIL_SERIES_ID = 101

function buildPlaylistText(channelCount: number): string {
  const categories = ["News", "Sports", "Entertainment", "Kids"]
  const lines = ['#EXTM3U x-tvg-url="https://fixtures.invalid/epg.xml"']
  for (let index = 1; index <= channelCount; index++) {
    const category = categories[index % categories.length]
    const name = `${category} Channel ${index}`
    lines.push(
      `#EXTINF:-1 tvg-id="ch-${index}" tvg-logo="" group-title="${category}",${name}`,
      `https://fixtures.invalid/live/${index}.m3u8`
    )
  }
  return lines.join("\n")
}

async function mockProvider(page: Page) {
  const playlistText = buildPlaylistText(40)
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

function seedPrefs() {
  try {
    localStorage.setItem(
      "xt_prefs",
      JSON.stringify({
        fixture: {
          favVod: [1, 2, 3, 4],
          favSeries: [2000],
          watchVod: { 6: { ts: 1700000000000, name: "Movie 6" } },
          progVod: { 8: { position: 600, duration: 5400, ts: 1700000600000, name: "Movie 8" } },
        },
      })
    )
  } catch {}
}

async function seedCatalogCache(page: Page): Promise<void> {
  await page.evaluate(
    async ({ movieCount, seriesCount, detailSeriesId }) => {
      const poster =
        "data:image/svg+xml;base64," +
        btoa('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#334"/></svg>')
      const movies = Array.from({ length: movieCount }, (_, index) => ({
        id: index + 1,
        name: `Movie ${index + 1}`,
        logo: poster,
        year: String(2000 + (index % 20)),
        rating: "7.5",
        category: "Drama",
        plot: "Movie plot.",
        added: 1700000000 - index * 1000,
        tmdb: null,
        genre: "Drama",
      }))
      const shows = Array.from({ length: seriesCount }, (_, index) => ({
        id: 2000 + index,
        name: `Show ${index + 1}`,
        logo: poster,
        year: String(2010 + index),
        rating: "8.1",
        category: "Drama",
        plot: "Show plot.",
        added: 1700000000 - index * 2000,
        tmdb: null,
        genre: "Drama",
      }))
      const episodes: Record<string, unknown[]> = {}
      let episodeId = detailSeriesId * 1000
      for (let season = 1; season <= 2; season++) {
        episodes[String(season)] = Array.from({ length: 6 }, (_, index) => ({
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
          plot: "A series description for the TV detail hero band.",
          genre: "Drama, Mystery",
          releaseDate: "2015-03-01",
          rating: "8.4",
        },
        seasons: [{ season_number: 1 }, { season_number: 2 }],
        episodes,
      }

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
        store.put(record(movies), "xt_cache:fixture:vod")
        store.put(record(shows), "xt_cache:fixture:series")
        store.put(record(seriesInfo), `xt_cache:fixture:series_info_${detailSeriesId}`)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    { movieCount: MOVIE_COUNT, seriesCount: SERIES_COUNT, detailSeriesId: DETAIL_SERIES_ID }
  )
}

async function primeCache(page: Page): Promise<void> {
  await mockProvider(page)
  await seedTvState(page)
  await page.context().addInitScript(seedPrefs)
  await page.goto("/tv")
  await page.waitForSelector(RAIL_ITEMS)
  await seedCatalogCache(page)
}

async function waitForHomeRails(page: Page) {
  await page.waitForSelector("[data-tv-view-root] [data-focus-key]")
  const cardCount = () => page.locator("[data-tv-view-root] [data-focus-key]").count()
  await expect
    .poll(async () => {
      const before = await cardCount()
      await page.waitForTimeout(300)
      return (await cardCount()) === before ? before : -1
    })
    .toBeGreaterThan(0)
}

async function assertNoHorizontalOverflow(page: Page, viewportWidth: number): Promise<void> {
  const widths = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-tv-view-root]")
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      rootScrollWidth: root ? root.scrollWidth : 0,
      rootClientWidth: root ? root.clientWidth : 0,
    }
  })
  expect(widths.documentScrollWidth, "document overflows horizontally").toBeLessThanOrEqual(widths.innerWidth)
  expect(widths.rootScrollWidth, "view root overflows horizontally").toBeLessThanOrEqual(widths.rootClientWidth)
  expect(widths.innerWidth).toBe(viewportWidth)
}

async function assertRailFitsViewport(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll<HTMLElement>('#tv-nav [data-tv-nav-item]'))
    const surface = document.querySelector<HTMLElement>("#tv-nav .tv-rail-surface")
    return {
      itemCount: items.length,
      allInside: items.every((item) => {
        const rect = item.getBoundingClientRect()
        return rect.top >= -0.5 && rect.bottom <= window.innerHeight + 0.5
      }),
      surfaceScrolls: surface ? surface.scrollHeight > surface.clientHeight + 1 : false,
    }
  })
  expect(result.itemCount, "expected 7 nav links + playlist + cast rows").toBe(9)
  expect(result.allInside, "a rail item is clipped outside the viewport").toBe(true)
  expect(result.surfaceScrolls, "the nav rail needs a vertical scrollbar").toBe(false)
}

async function assertFocusRingInsideViewport(page: Page): Promise<void> {
  const rect = await page.evaluate(() => {
    const active = document.activeElement
    if (!active || active === document.body) return null
    const box = active.getBoundingClientRect()
    return { top: box.top, left: box.left, right: box.right, bottom: box.bottom }
  })
  expect(rect, "no element holds focus").not.toBeNull()
  if (!rect) return
  expect(rect.top).toBeGreaterThanOrEqual(-0.5)
  expect(rect.left).toBeGreaterThanOrEqual(-0.5)
  expect(rect.right).toBeLessThanOrEqual((await page.viewportSize())!.width + 0.5)
  expect(rect.bottom).toBeLessThanOrEqual((await page.viewportSize())!.height + 0.5)
}

async function fullyVisiblePosterCardCount(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    // The hero band is also a <section>, so the first match may be its own gradient
    // div rather than a rail scroller; skip matches with no poster/live cards inside.
    const scrollers = Array.from(document.querySelectorAll<HTMLElement>(selector))
    const firstRailScroller = scrollers.find((scroller) => scroller.querySelector("[data-focus-key]"))
    if (!firstRailScroller) return 0
    const cards = Array.from(firstRailScroller.querySelectorAll<HTMLElement>("[data-focus-key]"))
    return cards.filter((card) => {
      const rect = card.getBoundingClientRect()
      return rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5 && rect.width > 0
    }).length
  }, HOME_RAIL_TRACKS)
}

async function liveChannelColumnRem(page: Page): Promise<{ widthRem: number; anyNameWraps: boolean }> {
  return page.evaluate(() => {
    const column = document.querySelector<HTMLElement>('[data-role="channels-col"]')
    const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const width = column ? column.getBoundingClientRect().width : 0
    const nameEls = Array.from(document.querySelectorAll<HTMLElement>('[data-channel-id] .truncate.font-semibold'))
    const anyNameWraps = nameEls.some((el) => el.scrollHeight > el.clientHeight + 1)
    return { widthRem: width / rootFontSize, anyNameWraps }
  })
}

async function assertRootFontSizeMatchesFormula(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const fontSize = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const expected = Math.min(window.innerWidth / 60, window.innerHeight / 33.75)
    return { fontSize, expected }
  })
  expect(Math.abs(result.fontSize - result.expected), "root font-size drifted from the 60rem x 33.75rem formula").toBeLessThanOrEqual(0.5)
}

async function railWidthRatio(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nav = document.getElementById("tv-nav")
    return nav ? nav.getBoundingClientRect().width / window.innerWidth : 0
  })
}

async function actionRowLineCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const row = document.getElementById("tv-detail-actions")
    if (!row) return 0
    const tops = new Set<number>()
    for (const button of Array.from(row.children)) {
      tops.add(Math.round(button.getBoundingClientRect().top))
    }
    return tops.size
  })
}

const TEMP_DIR = tmpdir()

interface RouteCase {
  key: string
  path: string
  ready: (page: Page) => Promise<void>
  extraAssertions?: (page: Page) => Promise<void>
}

function buildRouteCases(): RouteCase[] {
  return [
    {
      key: "home",
      path: "/tv",
      ready: async (page) => {
        await page.goto("/tv")
        await waitForHomeRails(page)
      },
      extraAssertions: async (page) => {
        const visibleCards = await fullyVisiblePosterCardCount(page)
        expect(visibleCards, "fewer than 4 poster cards fully visible in the first home rail").toBeGreaterThanOrEqual(4)
      },
    },
    {
      key: "live",
      path: "/tv/live",
      ready: async (page) => {
        await page.goto("/tv/live")
        await page.waitForSelector('[data-focus-key^="ch:"]')
        await page.waitForTimeout(300)
      },
      extraAssertions: async (page) => {
        const { widthRem, anyNameWraps } = await liveChannelColumnRem(page)
        expect(widthRem, "live channel column is narrower than 26rem").toBeGreaterThanOrEqual(26)
        expect(anyNameWraps, "a channel name wrapped onto a second line").toBe(false)
      },
    },
    {
      key: "movies",
      path: "/tv/movies",
      ready: async (page) => {
        await page.goto("/tv/movies")
        await page.waitForSelector("[data-grid-index]")
        await page.waitForTimeout(300)
      },
    },
    {
      key: "series-detail",
      path: `/tv/series/detail?id=${DETAIL_SERIES_ID}`,
      ready: async (page) => {
        await page.goto(`/tv/series/detail?id=${DETAIL_SERIES_ID}`)
        await page.waitForSelector('[data-focus-key^="ep:"]')
        await page.waitForTimeout(300)
      },
      extraAssertions: async (page) => {
        const lines = await actionRowLineCount(page)
        expect(lines, "the detail action row wraps past two lines").toBeLessThanOrEqual(2)
      },
    },
    {
      key: "settings",
      path: "/tv/settings",
      ready: async (page) => {
        await page.goto("/tv/settings")
        await page.waitForSelector("#tv-settings-rows [data-focus-key]")
      },
    },
    {
      key: "search",
      path: "/tv/search?q=news",
      ready: async (page) => {
        await page.goto("/tv/search?q=news")
        await page.waitForSelector('[data-focus-key="search:input"]')
        await page.waitForTimeout(300)
      },
    },
  ]
}

interface ViewportSuite {
  label: string
  width: number
  height: number
  deviceScaleFactor: number
  routeKeys?: string[]
  screenshotPrefix?: string
}

function registerViewportSuite(suite: ViewportSuite): void {
  test.describe(`TV layout at ${suite.label}`, () => {
    test.use({
      viewport: { width: suite.width, height: suite.height },
      deviceScaleFactor: suite.deviceScaleFactor,
    })

    const routeCases = suite.routeKeys
      ? buildRouteCases().filter((entry) => suite.routeKeys!.includes(entry.key))
      : buildRouteCases()

    for (const routeCase of routeCases) {
      test(`${routeCase.key} has no overflow and fits the 60rem canvas`, async ({ page }) => {
        await primeCache(page)
        await routeCase.ready(page)

        await assertNoHorizontalOverflow(page, suite.width)
        await assertRailFitsViewport(page)
        await assertFocusRingInsideViewport(page)
        await assertRootFontSizeMatchesFormula(page)
        if (routeCase.extraAssertions) await routeCase.extraAssertions(page)

        if (suite.screenshotPrefix) {
          await page.screenshot({ path: join(TEMP_DIR, `${suite.screenshotPrefix}-${routeCase.key}.png`) })
        }
      })
    }
  })
}

registerViewportSuite({
  label: "960x540 @2x (Android TV canonical viewport)",
  width: 960,
  height: 540,
  deviceScaleFactor: 2,
  screenshotPrefix: "tv-960",
})

registerViewportSuite({
  label: "1280x720 @1.5x (desktop testing viewport)",
  width: 1280,
  height: 720,
  deviceScaleFactor: 1.5,
})

registerViewportSuite({
  label: "1920x1080 @1x (desktop testing viewport)",
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  routeKeys: ["home", "live"],
  screenshotPrefix: "tv-1080",
})

registerViewportSuite({
  label: "2560x1440 @1x (desktop monitor at 100% scaling)",
  width: 2560,
  height: 1440,
  deviceScaleFactor: 1,
  routeKeys: ["home", "live"],
  screenshotPrefix: "tv-2k",
})

registerViewportSuite({
  label: "3840x2160 @1x (4K desktop monitor at 100% scaling)",
  width: 3840,
  height: 2160,
  deviceScaleFactor: 1,
  routeKeys: ["home", "live"],
  screenshotPrefix: "tv-4k",
})

// 3840x2160 physical @2x DPR resolves to the same 1920x1080 CSS canvas as the plain
// 1920x1080 @1x suite above - this is the "real 4K TV framebuffer" case.
registerViewportSuite({
  label: "3840x2160 @2x (4K TV framebuffer, density 640)",
  width: 1920,
  height: 1080,
  deviceScaleFactor: 2,
  routeKeys: ["home", "live"],
})

test.describe("TV layout proportions stay constant across sizes", () => {
  const CSS_WIDTHS: Array<{ width: number; height: number }> = [
    { width: 960, height: 540 },
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 3840, height: 2160 },
  ]

  test("rail-width ratio and first-rail visible card count are size-independent", async ({ page }) => {
    await primeCache(page)

    const samples: Array<{ width: number; railRatio: number; visibleCards: number }> = []
    for (const size of CSS_WIDTHS) {
      await page.setViewportSize(size)
      await page.goto("/tv")
      await waitForHomeRails(page)
      await assertRootFontSizeMatchesFormula(page)
      samples.push({
        width: size.width,
        railRatio: await railWidthRatio(page),
        visibleCards: await fullyVisiblePosterCardCount(page),
      })
    }

    const baseline = samples[0]
    for (const sample of samples.slice(1)) {
      expect(
        Math.abs(sample.railRatio - baseline.railRatio),
        `rail-width ratio drifted at ${sample.width}px (${sample.railRatio} vs ${baseline.railRatio})`
      ).toBeLessThan(0.01)
      expect(
        sample.visibleCards,
        `visible card count drifted at ${sample.width}px (${sample.visibleCards} vs ${baseline.visibleCards})`
      ).toBe(baseline.visibleCards)
    }
  })

  test("a 4K TV framebuffer (3840x2160 @2x) matches the 1920x1080 @1x baseline", async ({ browser }) => {
    const baselineContext = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
    const baselinePage = await baselineContext.newPage()
    await primeCache(baselinePage)
    await baselinePage.goto("/tv")
    await waitForHomeRails(baselinePage)
    const baseline = { railRatio: await railWidthRatio(baselinePage), visibleCards: await fullyVisiblePosterCardCount(baselinePage) }
    await baselineContext.close()

    const tvContext = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 })
    const tvPage = await tvContext.newPage()
    await primeCache(tvPage)
    await tvPage.goto("/tv")
    await waitForHomeRails(tvPage)
    const tvSample = { railRatio: await railWidthRatio(tvPage), visibleCards: await fullyVisiblePosterCardCount(tvPage) }
    await tvContext.close()

    expect(tvSample.railRatio).toBeCloseTo(baseline.railRatio, 5)
    expect(tvSample.visibleCards).toBe(baseline.visibleCards)
  })

  // img-cache.ts caps cached poster bitmaps at IMG_KIND_MAX_DIM.poster = 576px regardless of
  // display size; a 9.5rem poster card at a 64px root (a 4K TV canvas) requests ~608 CSS px,
  // so the cached bitmap upscales and turns visibly soft. Follow-up, not fixed here.
  test("poster cards at a very large root size exceed the image cache's max cached dimension", async ({ page }) => {
    await primeCache(page)
    await page.setViewportSize({ width: 3840, height: 2160 })
    await page.goto("/tv")
    await waitForHomeRails(page)

    const cardCssWidth = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-focus-key$=":vod:1"] [data-poster-wrap]')
      return card ? card.getBoundingClientRect().width : 0
    })
    const posterCacheMaxDim = 576
    expect(
      cardCssWidth,
      "expected the poster card CSS width to exceed the image cache's max cached dimension at this canvas size " +
        "(informational: confirms the known softness follow-up, not a pass/fail layout bug)"
    ).toBeGreaterThan(posterCacheMaxDim)
  })
})
