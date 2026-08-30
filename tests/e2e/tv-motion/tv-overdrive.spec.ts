// TV motion overdrive: hero crossfade, focus glide, card lift, grid/guide reconcile identity,
// and the playback OSD. These assert the target motion behaviour and are expected to fail until
// each feature lands - see the report to the orchestrator for which selectors are real vs guessed.
import { test, expect, type Page, type Locator } from "@playwright/test"
import { entryImageUrl, pressDpad, seedTvMotionCatalog, seedTvMotionState, settleMotion } from "./tv-seed"

const SEL = {
  navItem: "#tv-nav [data-tv-nav-item]",
  hero: '[data-focus-key="hero"]',
  posterWrap: "[data-poster-wrap]",
  cardTitle: "[data-card-title]",
  entryKey: "[data-entry-key]",
  gridIndex: "[data-grid-index]",
  focusGlide: "#tv-focus-glide",
  filterQuery: '[data-focus-key="filter:query"]',
  channelKey: "[data-channel-key]",
  guideFavButton: '[data-focus-key^="guide-fav:"]',
  osdLiveBanner: '[data-role="live-banner"]',
  osdZapDigits: '[data-role="zap-digits"]',
} as const

function vodCard(id: number): string {
  return `[data-focus-key$=":vod:${id}"]`
}

async function waitForHomeRails(page: Page): Promise<void> {
  await page.waitForSelector(`[data-tv-view-root] [data-focus-key]`)
  const cardCount = () => page.locator("[data-tv-view-root] [data-focus-key]").count()
  await expect
    .poll(async () => {
      const before = await cardCount()
      await page.waitForTimeout(400)
      return (await cardCount()) === before ? before : -1
    })
    .toBeGreaterThan(0)
}

async function openHomeWithRails(page: Page, options: { perfMode?: boolean; effects?: "full" | "lite" } = {}): Promise<void> {
  await seedTvMotionState(page, options)
  await page.goto("/tv")
  await page.waitForSelector(SEL.navItem)
  await seedTvMotionCatalog(page)
  await page.goto("/tv")
  await waitForHomeRails(page)
}

function focusByKey(page: Page, focusKey: string): Promise<void> {
  return page.evaluate((key) => {
    document.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)?.focus()
  }, focusKey)
}

/** Two focusable cards from the same "vod" rail, so ArrowRight moves directly between them. */
async function vodRailCardKeys(page: Page): Promise<{ firstKey: string; secondKey: string } | null> {
  return page.evaluate((suffixSelector) => {
    const first = document.querySelector<HTMLElement>(suffixSelector)
    const focusKey = first?.dataset.focusKey || ""
    const railId = focusKey.split(":vod:")[0]
    if (!railId) return null
    const secondKey = `${railId}:vod:2`
    return document.querySelector(`[data-focus-key="${secondKey}"]`) ? { firstKey: focusKey, secondKey } : null
  }, vodCard(1))
}

async function pollUntil<T>(
  page: Page,
  windowMs: number,
  intervalMs: number,
  sample: () => Promise<T>,
  predicate: (value: T) => boolean
): Promise<T> {
  const deadline = Date.now() + windowMs
  let last = await sample()
  while (!predicate(last) && Date.now() < deadline) {
    await page.waitForTimeout(intervalMs)
    last = await sample()
  }
  return last
}

async function sampleMin(page: Page, windowMs: number, intervalMs: number, sample: () => Promise<number>): Promise<number> {
  const deadline = Date.now() + windowMs
  let min = Infinity
  while (Date.now() < deadline) {
    const value = await sample()
    if (value < min) min = value
    await page.waitForTimeout(intervalMs)
  }
  return min
}

function heroSection(page: Page): Locator {
  return page.locator(SEL.hero).locator("xpath=ancestor::section[1]")
}

function guideHeroImages(page: Page): Locator {
  return page
    .locator(SEL.guideFavButton)
    .locator("xpath=ancestor::div[contains(@class,'tv-edge-mask')][1]")
    .locator("img")
}

test.describe("home hero backdrop crossfade", () => {
  test("crossfades through two layers on focus change, then settles on the new entry", async ({ page }) => {
    await openHomeWithRails(page)
    const keys = await vodRailCardKeys(page)
    expect(keys, "no adjacent vod:1/vod:2 pair found on the home rails").not.toBeNull()

    await focusByKey(page, keys!.firstKey)
    await settleMotion(page, 300)

    await pressDpad(page, "ArrowRight")
    const duringCount = await pollUntil(page, 700, 20, () => heroSection(page).locator("img").count(), (count) => count >= 2)
    expect(duringCount, "the hero never showed two backdrop layers during the change").toBeGreaterThanOrEqual(2)

    await settleMotion(page, 900)
    expect(await heroSection(page).locator("img").count()).toBe(1)
    // data-backdrop-url carries the original artwork URL; the img's own src can be an
    // img-cache blob: URL once the downscaled copy is cached, which src alone can't tell apart.
    const finalBackdropUrl = await heroSection(page).locator("img").first().getAttribute("data-backdrop-url")
    expect(finalBackdropUrl).toBe(entryImageUrl(2))
  })
})

test.describe("lite effect tier", () => {
  test("skips Ken Burns and ambient colour on a low-capability device", async ({ page }) => {
    await openHomeWithRails(page, { effects: "lite" })
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-tv-effects"))).toBe("lite")

    const keys = await vodRailCardKeys(page)
    expect(keys).not.toBeNull()
    await focusByKey(page, keys!.firstKey)
    await settleMotion(page, 900)

    const runningAnimations = await heroSection(page)
      .locator("img")
      .first()
      .evaluate((img) => img.getAnimations().length)
    expect(runningAnimations, "the backdrop img should have no Ken Burns animation in lite tier").toBe(0)

    const ambientVar = await heroSection(page).evaluate((section) =>
      getComputedStyle(section).getPropertyValue("--tv-ambient").trim()
    )
    expect(ambientVar, "--tv-ambient should stay unset when ambient colour extraction is skipped").toBe("")
  })
})

test.describe("focus glide", () => {
  async function glideMatchesFocusedCard(page: Page, toleranceCss = 2) {
    return page.evaluate((tolerance) => {
      const glide = document.querySelector<HTMLElement>("#tv-focus-glide")
      const posterWrap = document.activeElement?.querySelector<HTMLElement>("[data-poster-wrap]") || null
      if (!glide || !posterWrap) return { matched: false }
      const glideRect = glide.getBoundingClientRect()
      const cardRect = posterWrap.getBoundingClientRect()
      const matched =
        Math.abs(glideRect.left - cardRect.left) <= tolerance &&
        Math.abs(glideRect.top - cardRect.top) <= tolerance &&
        Math.abs(glideRect.right - cardRect.right) <= tolerance &&
        Math.abs(glideRect.bottom - cardRect.bottom) <= tolerance
      return { matched }
    }, toleranceCss)
  }

  test("tracks the focused card and follows it across rails", async ({ page }) => {
    await openHomeWithRails(page)
    const keys = await vodRailCardKeys(page)
    expect(keys).not.toBeNull()

    await focusByKey(page, keys!.firstKey)
    await pressDpad(page, "ArrowRight")
    const afterRight = await pollUntil(page, 400, 20, () => glideMatchesFocusedCard(page), (result) => result.matched)
    expect(afterRight.matched, "glide did not settle onto the focused card").toBe(true)

    await pressDpad(page, "ArrowDown")
    const afterDown = await pollUntil(page, 400, 20, () => glideMatchesFocusedCard(page), (result) => result.matched)
    expect(afterDown.matched, "glide did not follow focus into the next rail").toBe(true)
  })

  test("perf mode uses the static focus ring instead of the glide element", async ({ page }) => {
    await openHomeWithRails(page, { perfMode: true })
    const keys = await vodRailCardKeys(page)
    expect(keys).not.toBeNull()

    await focusByKey(page, keys!.firstKey)
    await pressDpad(page, "ArrowRight")
    await settleMotion(page, 400)

    expect(await page.locator(SEL.focusGlide).count()).toBe(0)
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-tv-glide"))).toBe(false)
  })
})

test.describe("card lift", () => {
  test("the focused poster scales up; an unfocused poster does not", async ({ page }) => {
    await openHomeWithRails(page)
    const keys = await vodRailCardKeys(page)
    expect(keys).not.toBeNull()

    await focusByKey(page, keys!.firstKey)
    await settleMotion(page, 250)

    const focusedScale = await page.evaluate(() => {
      const posterWrap = document.activeElement?.querySelector<HTMLElement>("[data-poster-wrap]")
      const transform = posterWrap ? getComputedStyle(posterWrap).transform : "none"
      const match = transform.match(/matrix\(([^,]+),/)
      return match ? Number(match[1]) : null
    })
    expect(focusedScale, "focused poster has no scale transform").not.toBeNull()
    expect(focusedScale!).toBeGreaterThan(1.02)
    expect(focusedScale!).toBeLessThan(1.06)

    const unfocusedTransform = await page.evaluate((selector) => {
      const posterWrap = document.querySelector(selector)?.querySelector<HTMLElement>("[data-poster-wrap]")
      return posterWrap ? getComputedStyle(posterWrap).transform : null
    }, `[data-focus-key="${keys!.secondKey}"]`)
    expect(unfocusedTransform).toBe("none")
  })
})

test.describe("movies grid filter transition", () => {
  test("filtering never mounts zero cards and keeps the surviving card's identity", async ({ page }) => {
    await seedTvMotionState(page)
    await page.goto("/tv")
    await page.waitForSelector(SEL.navItem)
    await seedTvMotionCatalog(page)
    await page.goto("/tv/movies")
    await page.waitForSelector(SEL.gridIndex)
    await settleMotion(page, 300)

    const targetName = await page.evaluate(
      (selector) => document.querySelector(selector)?.textContent?.trim() || "",
      `[data-grid-index="0"] ${SEL.cardTitle}`
    )
    expect(targetName).not.toBe("")

    const entryKey = await page.evaluate((selector) => {
      const card = document.querySelector<HTMLElement & { __probe?: boolean }>(selector)
      if (card) card.__probe = true
      return card?.dataset.entryKey || null
    }, '[data-grid-index="0"]')
    expect(entryKey, "grid cards should carry a stable data-entry-key").not.toBeNull()

    const minCountPromise = sampleMin(page, 900, 40, () => page.locator(SEL.gridIndex).count())
    await page.locator(SEL.filterQuery).fill(targetName)
    const minCount = await minCountPromise
    expect(minCount, "the grid rendered a frame with zero mounted cards during the filter change").toBeGreaterThan(0)

    const survived = await page.evaluate((key) => {
      const card = document.querySelector<HTMLElement & { __probe?: boolean }>(`[data-entry-key="${key}"]`)
      return card ? card.__probe === true : false
    }, entryKey)
    expect(survived, "the surviving card was rebuilt instead of reconciled in place").toBe(true)
  })
})

test.describe("live guide patch-in-place", () => {
  test("switching channels keeps the guide identity node connected and crossfades the backdrop", async ({ page }) => {
    await seedTvMotionState(page)
    await page.goto("/tv/live")
    await page.waitForSelector('[data-focus-key="ch:1"]')
    await focusByKey(page, "ch:1")
    await settleMotion(page, 300)

    const before = await page.evaluate((selector) => {
      const favButton = document.querySelector(selector)
      const nameEl = favButton?.parentElement?.children[1] as (HTMLElement & { __probe?: boolean }) | undefined
      if (nameEl) nameEl.__probe = true
      return nameEl?.textContent ?? null
    }, SEL.guideFavButton)
    expect(before, "could not find the guide's channel-name node").not.toBeNull()

    const imagePoll = pollUntil(page, 700, 30, () => guideHeroImages(page).count(), (count) => count >= 2)
    await pressDpad(page, "ArrowDown")
    await settleMotion(page, 300)
    expect(await imagePoll, "the guide backdrop never crossfaded two layers").toBeGreaterThanOrEqual(2)

    const after = await page.evaluate((selector) => {
      const favButton = document.querySelector(selector)
      const nameEl = favButton?.parentElement?.children[1] as (HTMLElement & { __probe?: boolean }) | undefined
      return { text: nameEl?.textContent ?? null, sameNode: nameEl?.__probe === true }
    }, SEL.guideFavButton)
    expect(after.sameNode, "the guide rebuilt the channel-name node instead of patching it in place").toBe(true)
    expect(after.text).not.toBe(before)
  })
})

test.describe("playback OSD", () => {
  test("the live banner appears on tune and auto-hides", async ({ page }) => {
    await seedTvMotionState(page)
    await page.goto("/tv/live")
    await page.waitForSelector('[data-focus-key="ch:1"]')
    await focusByKey(page, "ch:1")
    await pressDpad(page, "Enter")

    await expect(page.locator(SEL.osdLiveBanner)).toBeVisible({ timeout: 1000 })
    await expect(page.locator(SEL.osdLiveBanner)).toBeHidden({ timeout: 5500 })
  })

  test("the zap OSD shows typed digits", async ({ page }) => {
    await seedTvMotionState(page)
    await page.goto("/tv/live")
    await page.waitForSelector('[data-focus-key="ch:1"]')
    await focusByKey(page, "ch:1")
    await pressDpad(page, "Enter")
    await expect(page.locator(SEL.osdLiveBanner)).toBeVisible({ timeout: 2000 })

    await pressDpad(page, "1")
    await pressDpad(page, "2")
    await expect(page.locator(SEL.osdZapDigits)).toHaveText("12", { timeout: 1000 })
  })
})
