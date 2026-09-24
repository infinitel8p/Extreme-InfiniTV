// xt_ui_mode picks TV vs classic UI; data-tv (device) and data-tv-ui (layout) are independent.
import { test, expect, type Page } from "@playwright/test"

async function seedLocalStorage(page: Page, values: Record<string, string>): Promise<void> {
  await page.context().addInitScript((entries) => {
    try {
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
    } catch {}
  }, values)
}

async function htmlAttrs(page: Page): Promise<{ tv: string | null; tvUi: string | null }> {
  return page.evaluate(() => ({
    tv: document.documentElement.getAttribute("data-tv"),
    tvUi: document.documentElement.getAttribute("data-tv-ui"),
  }))
}

test("stored tv mode sends a desktop device to /tv without stamping data-tv", async ({ page }) => {
  await seedLocalStorage(page, { xt_ui_mode: "tv", xt_locale: "en" })
  await page.goto("/")
  await page.waitForFunction(() => location.pathname.replace(/\/$/, "") === "/tv" || location.pathname === "/tv")

  const attrs = await htmlAttrs(page)
  expect(attrs.tvUi).toBe("1")
  expect(attrs.tv).toBeNull()
})

test("stored desktop mode sends a UA false-positive TV back to the classic UI", async ({ page }) => {
  await seedLocalStorage(page, { xt_ui_mode: "desktop", xt_is_tv: "1", xt_receiver_boot: "0", xt_locale: "en" })
  await page.goto("/tv")
  await page.waitForFunction(() => location.pathname === "/" || location.pathname === "")
})

test("a detected TV device with no stored mode lands on /tv and stamps data-tv", async ({ page }) => {
  await seedLocalStorage(page, { xt_is_tv: "1", xt_receiver_boot: "0", xt_locale: "en" })
  await page.goto("/")
  await page.waitForFunction(() => location.pathname.replace(/\/$/, "") === "/tv" || location.pathname === "/tv")

  const attrs = await htmlAttrs(page)
  expect(attrs.tv).toBe("1")
  expect(attrs.tvUi).toBe("1")
})

test("the legacy xt_force_tv flag migrates into xt_ui_mode on load", async ({ page }) => {
  await seedLocalStorage(page, { xt_force_tv: "1", xt_locale: "en" })
  await page.goto("/")
  await page.waitForFunction(() => location.pathname.replace(/\/$/, "") === "/tv" || location.pathname === "/tv")

  const stored = await page.evaluate(() => ({
    uiMode: localStorage.getItem("xt_ui_mode"),
    legacyFlag: localStorage.getItem("xt_force_tv"),
  }))
  expect(stored.uiMode).toBe("tv")
  expect(stored.legacyFlag).toBeNull()
})
