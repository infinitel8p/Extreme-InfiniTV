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
