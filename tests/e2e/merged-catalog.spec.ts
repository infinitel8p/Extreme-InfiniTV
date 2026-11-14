// Merged catalogs (#164): two Xtream playlists sharing one /movies grid, ids colliding on purpose.
import { test, expect, type Page } from "@playwright/test"

const PLAYLIST_A = "pl-a"
const PLAYLIST_B = "pl-b"
const NAME_BY_HOST: Record<string, string> = { a: "Alpha Movie", b: "Beta Movie" }

interface SeedOptions {
  mergeB: boolean
  failBStreams?: boolean
}

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

async function seed(page: Page, options: SeedOptions): Promise<void> {
  const playlists = {
    entries: [xtreamEntry(PLAYLIST_A, "a", "A", false), xtreamEntry(PLAYLIST_B, "b", "B", options.mergeB)],
    selectedId: PLAYLIST_A,
  }
  await page.context().addInitScript((state) => {
    try {
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
    const name = NAME_BY_HOST[host]
    const action = url.searchParams.get("action") || ""
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })

    if (action === "get_vod_categories") return json([{ category_id: "1", category_name: "Action", parent_id: 0 }])
    if (action === "get_vod_streams") {
      if (host === "b" && options.failBStreams) return json({ error: "boom" }, 500)
      return json([
        {
          num: 1,
          name,
          stream_id: 101,
          category_id: "1",
          container_extension: "mp4",
          added: "1700000000",
          rating: "7",
          year: "2020",
        },
      ])
    }
    if (action === "get_vod_info") {
      return json({
        info: { name, plot: `Plot of ${name}`, releasedate: "2020-01-01" },
        movie_data: { stream_id: 101, name, container_extension: "mp4" },
      })
    }
    if (action === "get_series_categories" || action === "get_series") return json([])
    return json({ user_info: { auth: 1, status: "Active", max_connections: "1" }, server_info: {} })
  })
}

const cardLinks = (page: Page) => page.locator('#movie-grid [data-role="play"]')

test("merged grid keeps same-id titles from two playlists as separate cards", async ({ page }) => {
  await seed(page, { mergeB: true })
  await page.goto("/movies")

  await expect(cardLinks(page)).toHaveCount(2)
  const hrefs = await cardLinks(page).evaluateAll((links) => links.map((link) => link.getAttribute("href") || ""))
  expect(hrefs.some((href) => href.includes(`pl=${PLAYLIST_A}`))).toBe(true)
  expect(hrefs.some((href) => href.includes(`pl=${PLAYLIST_B}`))).toBe(true)
  expect(new Set(hrefs).size).toBe(2)
  await expect(page.locator("#movie-merge-status")).toBeVisible()
})

test("same-named categories stay separate per playlist and filter to one card", async ({ page }) => {
  await seed(page, { mergeB: true })
  await page.goto("/movies")
  await expect(cardLinks(page)).toHaveCount(2)

  await page.locator("#movie-category-picker-trigger").click()
  const options = page.locator('#movie-category-picker-list [role="option"]')
  await expect(options.filter({ hasText: "Action · A" })).toHaveCount(1)
  await expect(options.filter({ hasText: "Action · B" })).toHaveCount(1)

  await options.filter({ hasText: "Action · B" }).click()
  await expect(cardLinks(page)).toHaveCount(1)
  expect(await cardLinks(page).first().getAttribute("href")).toContain(`pl=${PLAYLIST_B}`)
})

test("opening another playlist's title loads its row without switching the active playlist", async ({ page }) => {
  await seed(page, { mergeB: true })
  await page.goto(`/movies/detail?id=101&pl=${PLAYLIST_B}`)

  await expect(page.locator("#movie-detail-title")).toContainText("Beta Movie")
  const selectedId = await page.evaluate(() => JSON.parse(localStorage.getItem("xt_playlists") || "{}").selectedId)
  expect(selectedId).toBe(PLAYLIST_A)
})

test("a failing playlist still paints the others with a retry pill and a toast", async ({ page }) => {
  await seed(page, { mergeB: true, failBStreams: true })
  await page.goto("/movies")

  await expect(cardLinks(page)).toHaveCount(1)
  expect(await cardLinks(page).first().getAttribute("href")).toContain(`pl=${PLAYLIST_A}`)
  const errorPill = page.locator('#movie-merge-status [data-status="error"]')
  await expect(errorPill).toBeVisible({ timeout: 15_000 })
  await expect(errorPill.getByRole("button", { name: "Retry" })).toBeVisible()
  await expect(page.locator(".xt-toast")).toBeVisible()
})

test("without a merge flag the grid shows one playlist and the status strip stays hidden", async ({ page }) => {
  await seed(page, { mergeB: false })
  await page.goto("/movies")

  await expect(cardLinks(page)).toHaveCount(1)
  expect(await cardLinks(page).first().getAttribute("href")).toContain(`pl=${PLAYLIST_A}`)
  await expect(page.locator("#movie-merge-status")).toBeHidden()
})
