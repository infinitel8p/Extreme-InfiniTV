// TV settings rows for language grouping / preferred audio language / EPG time zone,
// plus grouping behavior in the TV movies grid and detail "also available in" pills.
import { test, expect, type Page } from "@playwright/test"

const PLAYLIST_ID = "fixture"

async function mockProvider(page: Page) {
  await page.route("https://fixtures.invalid/**", (route) => {
    const url = route.request().url()
    if (url.includes("playlist.m3u")) {
      const body = [
        '#EXTM3U x-tvg-url="https://fixtures.invalid/epg.xml"',
        '#EXTINF:-1 tvg-id="ch-1" group-title="News",News Channel',
        "https://fixtures.invalid/live/1.m3u8",
      ].join("\n")
      return route.fulfill({ status: 200, contentType: "audio/x-mpegurl", body })
    }
    if (url.includes("epg.xml")) {
      const now = Date.now()
      const stamp = (ms: number) => {
        const date = new Date(ms)
        const pad = (value: number) => String(value).padStart(2, "0")
        return (
          `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
          `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
        )
      }
      const xml =
        '<?xml version="1.0"?><tv>' +
        `<programme start="${stamp(now - 3 * 3600_000)}" stop="${stamp(now + 3 * 3600_000)}" channel="ch-1">` +
        "<title>Now Playing</title></programme></tv>"
      return route.fulfill({ status: 200, contentType: "application/xml", body: xml })
    }
    return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" })
  })
}

async function seedTvState(page: Page) {
  await page.context().addInitScript(
    ({ playlistId }) => {
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
                _id: playlistId,
                type: "m3u",
                url: "https://fixtures.invalid/playlist.m3u",
                title: "Fixture TV",
                addedAt: 1,
                lastUsedAt: 1,
              },
            ],
            selectedId: playlistId,
          })
        )
        localStorage.setItem(
          "xt_prefs",
          JSON.stringify({ [playlistId]: { favLive: [1] } })
        )
      } catch {}
    },
    { playlistId: PLAYLIST_ID }
  )
}

async function seedVodCatalog(page: Page, movies: unknown[]): Promise<void> {
  await page.evaluate(
    async ({ playlistId, movies }) => {
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
      const record = { data: movies, fetchedAt: Date.now(), ttl: 7 * 24 * 60 * 60 * 1000 }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("entries", "readwrite")
        tx.objectStore("entries").put(record, `xt_cache:${playlistId}:vod`)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    { playlistId: PLAYLIST_ID, movies }
  )
}

async function primeTv(page: Page): Promise<void> {
  await mockProvider(page)
  await seedTvState(page)
  await page.goto("/tv")
  await page.waitForSelector("#tv-nav [data-tv-nav-item]")
}

async function seedM3uCatalog(page: Page, channels: unknown[]): Promise<void> {
  await page.evaluate(
    async ({ playlistId, channels }) => {
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
      const record = { data: channels, fetchedAt: Date.now(), ttl: 7 * 24 * 60 * 60 * 1000 }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("entries", "readwrite")
        tx.objectStore("entries").put(record, `xt_cache:${playlistId}:m3u`)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    { playlistId: PLAYLIST_ID, channels }
  )
}

// Seeds the M3U catalog cache + its known EPG header URL directly (instead of relying on a live
// M3U fetch + parse), then reloads so home.ts's very first render already has an EPG source to
// load from - the app never retries maybeLoadEpg() once a load attempt with no source has fired.
async function primeTvWithLiveEpg(page: Page): Promise<void> {
  await primeTv(page)
  await seedM3uCatalog(page, [{ id: 1, name: "News Channel", logo: null, tvgId: "ch-1", tvgShift: null, category: "News" }])
  await page.evaluate((playlistId) => {
    localStorage.setItem(`xt_m3u_epg:${playlistId}`, "https://fixtures.invalid/epg.xml")
  }, PLAYLIST_ID)
  await page.goto("/tv")
  await page.waitForSelector("#tv-nav [data-tv-nav-item]")
}

test.describe("TV settings: language grouping / audio language / EPG time zone", () => {
  test("language grouping toggle and preferred audio language rows exist and store values", async ({ page }) => {
    await primeTv(page)
    await page.goto("/tv/settings")
    await page.waitForSelector("#tv-settings-rows [data-focus-key]")

    const groupingRow = page.locator('[data-row-id="lang-grouping"]')
    await expect(groupingRow).toBeVisible()
    await expect(groupingRow).toHaveAttribute("aria-checked", "true")

    await groupingRow.click()
    await expect(groupingRow).toHaveAttribute("aria-checked", "false")
    expect(await page.evaluate(() => localStorage.getItem("xt_lang_grouping"))).toBe("0")

    await groupingRow.click()
    await expect(groupingRow).toHaveAttribute("aria-checked", "true")
    expect(await page.evaluate(() => localStorage.getItem("xt_lang_grouping"))).toBe("1")

    const contentLangRow = page.locator('[data-row-id="content-language"]')
    await expect(contentLangRow).toBeVisible()
    await expect(contentLangRow).toContainText("Auto")

    await contentLangRow.click()
    const dialog = page.locator("#tv-settings-choice-dialog")
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: /German \(DE\)/ }).click()
    await expect(dialog).toBeHidden()

    expect(await page.evaluate(() => localStorage.getItem("xt_content_lang"))).toBe("DE")
    await expect(contentLangRow).toContainText("German")
  })

  test("picking +1 h changes the stored EPG offset and shifts the live now-playing time", async ({ page }) => {
    await primeTvWithLiveEpg(page)

    // Focus the live favorite card so the hero shows its now-playing time before the change.
    await page.waitForSelector('[data-focus-key="favorites:live:1"]')
    await page.locator('[data-focus-key="favorites:live:1"]').focus()
    const readHeroMeta = () =>
      page.evaluate(() => {
        const button = document.querySelector('[data-focus-key="hero"]')
        const section = button?.closest("section")
        const paragraphs = section ? Array.from(section.querySelectorAll("p")) : []
        return paragraphs[1]?.textContent || ""
      })
    // The EPG fetch lands asynchronously after the rails paint; poll until the hero picks it up.
    await expect.poll(readHeroMeta, { timeout: 10_000 }).toContain("Now Playing")
    const before = await readHeroMeta()

    await page.goto("/tv/settings")
    await page.waitForSelector("#tv-settings-rows [data-focus-key]")
    const offsetRow = page.locator('[data-row-id="epg-offset"]')
    await offsetRow.click()
    const dialog = page.locator("#tv-settings-choice-dialog")
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "UTC+01:00", exact: true }).click()
    await expect(dialog).toBeHidden()

    expect(await page.evaluate((playlistId) => localStorage.getItem(`xt_epg_offset:${playlistId}`), PLAYLIST_ID)).toBe(
      "60"
    )

    await page.goto("/tv")
    await page.waitForSelector('[data-focus-key="favorites:live:1"]')
    await page.locator('[data-focus-key="favorites:live:1"]').focus()
    await expect.poll(readHeroMeta, { timeout: 10_000 }).toContain("Now Playing")
    const after = await readHeroMeta()

    function startMinutesOfDay(text: string): number {
      const match = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i)
      if (!match) throw new Error(`could not parse a time out of "${text}"`)
      let hours = Number(match[1]) % 12
      if (/pm/i.test(match[3])) hours += 12
      return hours * 60 + Number(match[2])
    }

    const delta = (startMinutesOfDay(after) - startMinutesOfDay(before) + 1440) % 1440
    expect(delta).toBe(60)
  })
})

test.describe("TV language grouping: movies grid + detail variants", () => {
  const MOVIES = [
    { id: 1, name: "EN - Same Movie (2020)", logo: null, year: "2020", rating: "7.0", category: "Drama", plot: "", added: 2, tmdb: 555 },
    { id: 2, name: "DE - Same Movie (2020)", logo: null, year: "2020", rating: "7.0", category: "Drama", plot: "", added: 1, tmdb: 555 },
  ]

  test("collapses language variants into one grid card with a language chip", async ({ page }) => {
    await primeTv(page)
    await seedVodCatalog(page, MOVIES)
    await page.goto("/tv/movies")
    await page.waitForSelector("[data-grid-index]")
    await page.waitForTimeout(300)

    const cards = page.locator("[data-grid-index]")
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText("Same Movie")

    const chip = page.locator(".entry-language-chips")
    await expect(chip).toBeVisible()
    await expect(chip).toContainText("EN")
    await expect(chip).toContainText("+1")
  })

  test("detail page offers the other language variant as a pill that navigates to it", async ({ page }) => {
    await primeTv(page)
    await seedVodCatalog(page, MOVIES)
    // Navigate in via the grid (a same-origin link click, not page.goto) so the client-side
    // transition keeps the in-memory catalog cache warm for the detail view's own reads.
    await page.goto("/tv/movies")
    await page.waitForSelector("[data-grid-index]")
    await page.locator("[data-grid-index]").first().click()
    await expect(page).toHaveURL(/id=1/)
    await page.waitForSelector("#tv-detail-language-variants a, #tv-detail-language-variants span")
    await page.waitForTimeout(300)

    const variantsRow = page.locator("#tv-detail-language-variants")
    await expect(variantsRow).toBeVisible()
    await expect(variantsRow.locator("a")).toHaveCount(1)

    await variantsRow.locator("a").click()
    await expect(page).toHaveURL(/id=2/)
    await page.waitForSelector("#tv-detail-language-variants a, #tv-detail-language-variants span")
    await expect(page.locator("#tv-detail-language-variants")).toContainText("German")
  })
})
