import { test, expect } from "@playwright/test"

test("picking Large in TV Settings stores the subtitle size", async ({ page }) => {
  await page.context().addInitScript(() => {
    try {
      localStorage.setItem("xt_ui_mode", "tv")
      localStorage.setItem("xt_receiver_boot", "0")
      localStorage.setItem("xt_locale", "en")
      localStorage.setItem("xt_theme", "dark")
      localStorage.setItem("xt_perf_mode", "1")
    } catch {}
  })
  await page.goto("/tv/settings")
  await page.waitForSelector("#tv-settings-rows [data-focus-key]")

  const sizeRow = page.locator('[data-row-id="subtitle-size"]')
  await expect(sizeRow).toContainText("Normal")
  await expect(page.locator('[data-row-id="epg-offset"]')).toBeVisible()
  const dialog = page.locator("#tv-settings-choice-dialog")
  await expect(async () => {
    await sizeRow.focus()
    await page.keyboard.press("Enter")
    await expect(dialog).toBeVisible({ timeout: 1000 })
  }).toPass()
  await dialog.getByRole("button", { name: /^Large/ }).click()
  await expect(dialog).toBeHidden()

  expect(await page.evaluate(() => localStorage.getItem("xt_subs_scale"))).toBe("large")
  await expect(sizeRow).toContainText("Large")
})
