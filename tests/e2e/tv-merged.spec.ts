// Merged catalogs (#164) on the TV UI: two Xtream playlists sharing live groups and the movies grid.
import { test, expect, type Page } from "@playwright/test"

const PLAYLIST_A = "pl-a"
const PLAYLIST_B = "pl-b"

const LIVE_BY_HOST: Record<string, number[]> = { a: [1, 2, 3], b: [1, 2] }

function xtreamEntry(id: string, host: string, title: string, mergedVisible: boolean) {
  return {
    _id: id,
    type: "xtream",
    serverUrl: `https://${host}.fixtures.invalid`,
    username: "user",
    password: "pass",
    title,
    addedAt: 1,
    lastUsedAt: 1,
    ...(mergedVisible ? { mergedVisible: true } : {}),
  }
}

async function seed(page: Page, options: { mergeB: boolean }): Promise<void> {
  const playlists = {
    entries: [xtreamEntry(PLAYLIST_A, "a", "A", false), xtreamEntry(PLAYLIST_B, "b", "B", options.mergeB)],
    selectedId: PLAYLIST_A,
  }
  await page.context().addInitScript((state) => {
    try {
      localStorage.setItem("xt_ui_mode", "tv")
      localStorage.setItem("xt_receiver_boot", "0")
      localStorage.setItem("xt_locale", "en")
      localStorage.setItem("xt_theme", "dark")
      localStorage.setItem("xt_perf_mode", "1")
      if (!localStorage.getItem("xt_playlists")) localStorage.setItem("xt_playlists", JSON.stringify(state))
    } catch {}
  }, playlists)

  await page.context().route("https://api.github.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  )
  await page.context().route(/^https:\/\/[ab]\.fixtures\.invalid\//, (route) => {
    const url = new URL(route.request().url())
    const host = url.hostname.split(".")[0]
    const action = url.searchParams.get("action") || ""
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })

    if (action === "get_live_categories") return json([{ category_id: "1", category_name: "News", parent_id: 0 }])
    if (action === "get_live_streams") {
      return json(
        (LIVE_BY_HOST[host] || []).map((streamId) => ({
          num: streamId,
          name: `${host.toUpperCase()} Channel ${streamId}`,
          stream_type: "live",
          stream_id: streamId,
          stream_icon: "",
          epg_channel_id: "",
          added: "1700000000",
          category_id: "1",
        }))
      )
    }
    if (action === "get_vod_categories") return json([{ category_id: "1", category_name: "Action", parent_id: 0 }])
    if (action === "get_vod_streams") {
      return json([
        {
          num: 1,
          name: `${host.toUpperCase()} Movie`,
          stream_id: 101,
          category_id: "1",
          container_extension: "mp4",
          added: "1700000000",
          rating: "7",
          year: "2020",
        },
      ])
    }
    if (action === "get_series_categories" || action === "get_series") return json([])
    return json({ user_info: { auth: 1, status: "Active", max_connections: "1" }, server_info: {} })
  })
}

test("TV live groups are labelled per playlist and list every merged channel", async ({ page }) => {
  await seed(page, { mergeB: true })
  await page.goto("/tv/live")

  const channelRows = page.locator("#tv-live-channels [data-channel-key]")
  await expect(channelRows).toHaveCount(5)

  const groupLabels = await page.locator("#tv-live-groups [data-group-key]").allInnerTexts()
  expect(groupLabels.some((label) => label.includes("News · A"))).toBe(true)
  expect(groupLabels.some((label) => label.includes("News · B"))).toBe(true)

  const rowKeys = await channelRows.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.channelKey))
  expect(new Set(rowKeys).size).toBe(5)
})

test("TV movies grid keeps same-id titles apart and links carry the playlist", async ({ page }) => {
  await seed(page, { mergeB: true })
  await page.goto("/tv/movies")

  const cards = page.locator("[data-grid-index]")
  await expect(cards).toHaveCount(2)
  const hrefs = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") || ""))
  expect(hrefs.some((href) => href.includes(`pl=${PLAYLIST_A}`))).toBe(true)
  expect(hrefs.some((href) => href.includes(`pl=${PLAYLIST_B}`))).toBe(true)
})

test("without a merge flag the TV movies grid shows one playlist and no pl param", async ({ page }) => {
  await seed(page, { mergeB: false })
  await page.goto("/tv/movies")

  const cards = page.locator("[data-grid-index]")
  await expect(cards).toHaveCount(1)
  expect(await cards.first().getAttribute("href")).not.toContain("pl=")
})

test("settings playlist action sheet offers the merged-view toggle for a non-active row", async ({ page }) => {
  await seed(page, { mergeB: false })
  await page.goto("/tv/settings")
  await page.waitForSelector("#tv-settings-rows [data-focus-key]")

  await page.locator('[data-row-id="playlists"]').click()
  const dialog = page.locator("#tv-settings-playlists-dialog")
  await expect(dialog).toBeVisible()

  await dialog.locator(`[data-entry-id="${PLAYLIST_B}"] button:not([data-role="main"])`).click()
  await expect(page.getByText(/Show in merged view/)).toBeVisible()
})
