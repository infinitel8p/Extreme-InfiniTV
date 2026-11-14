// #229: hidden VOD categories stay out of hub Recently Added, /recently-added and /search.
import { test, expect, type Page } from "@playwright/test"

const PLAYLIST_ID = "pl-hidden"
const HIDDEN_CATEGORY = "Hidden Stuff"
const NOW_SECONDS = Math.floor(Date.now() / 1000)

const MOVIES = [
  { id: 101, name: "Zephyr Chase", category_id: "1" },
  { id: 102, name: "Quasar Pursuit", category_id: "1" },
  { id: 201, name: "Mandrake Secret", category_id: "2" },
  { id: 202, name: "Obsidian Whisper", category_id: "2" },
]

async function seed(page: Page, hiddenCategories: string[]): Promise<void> {
  const playlists = {
    entries: [
      {
        _id: PLAYLIST_ID,
        type: "xtream",
        serverUrl: "https://h.fixtures.invalid",
        username: "user",
        password: "pass",
        title: "H",
        addedAt: 1,
        lastUsedAt: 1,
      },
    ],
    selectedId: PLAYLIST_ID,
  }
  await page.context().addInitScript(
    (state) => {
      try {
        localStorage.setItem("xt_locale", "en")
        localStorage.setItem("xt_theme", "dark")
        localStorage.setItem("xt_perf_mode", "1")
        if (!localStorage.getItem("xt_playlists")) localStorage.setItem("xt_playlists", JSON.stringify(state.playlists))
        if (!localStorage.getItem("xt_prefs")) {
          localStorage.setItem(
            "xt_prefs",
            JSON.stringify({ [state.playlistId]: { hiddenVod: state.hidden, catModeVod: "hide" } })
          )
        }
      } catch {}
    },
    { playlists, playlistId: PLAYLIST_ID, hidden: hiddenCategories }
  )

  await page.context().route("https://api.github.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  )
  await page.context().route(/^https:\/\/h\.fixtures\.invalid\//, (route) => {
    const action = new URL(route.request().url()).searchParams.get("action") || ""
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })

    if (action === "get_vod_categories") {
      return json([
        { category_id: "1", category_name: "Action", parent_id: 0 },
        { category_id: "2", category_name: HIDDEN_CATEGORY, parent_id: 0 },
      ])
    }
    if (action === "get_vod_streams") {
      return json(
        MOVIES.map((movie, index) => ({
          num: index + 1,
          name: movie.name,
          stream_id: movie.id,
          category_id: movie.category_id,
          container_extension: "mp4",
          added: String(NOW_SECONDS - index * 60),
          rating: "7",
          year: "2024",
        }))
      )
    }
    if (action === "get_series_categories" || action === "get_series" || action === "get_live_categories" || action === "get_live_streams") {
      return json([])
    }
    return json({ user_info: { auth: 1, status: "Active", max_connections: "1" }, server_info: {} })
  })
}

const detailLink = (page: Page, id: number) => page.locator(`a[href*="/movies/detail"][href*="id=${id}"]`)

async function expectVisibleOnly(page: Page, visibleIds: number[], hiddenIds: number[]): Promise<void> {
  for (const id of visibleIds) await expect(detailLink(page, id).first()).toBeVisible({ timeout: 15_000 })
  for (const id of hiddenIds) await expect(detailLink(page, id)).toHaveCount(0)
}

test("hub Recently Added strip omits hidden categories", async ({ page }) => {
  await seed(page, [HIDDEN_CATEGORY])
  await page.goto("/")
  await expectVisibleOnly(page, [101, 102], [201, 202])
  await expect(page.getByText("Mandrake Secret")).toHaveCount(0)
  await expect(page.getByText("Obsidian Whisper")).toHaveCount(0)
})

test("/recently-added omits hidden categories", async ({ page }) => {
  await seed(page, [HIDDEN_CATEGORY])
  await page.goto("/recently-added")
  await expectVisibleOnly(page, [101, 102], [201, 202])
  await expect(page.getByText("Mandrake Secret")).toHaveCount(0)
})

test("/search omits hidden-category titles but finds visible ones", async ({ page }) => {
  await seed(page, [HIDDEN_CATEGORY])
  await page.goto("/search?q=Mandrake")
  await expect(page.locator('input[type="search"]')).toHaveValue("Mandrake")
  await expect(page.getByText('No results for "Mandrake".')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("Mandrake Secret")).toHaveCount(0)
  await expect(detailLink(page, 201)).toHaveCount(0)

  await page.goto("/search?q=Zephyr")
  await expect(detailLink(page, 101).first()).toBeVisible({ timeout: 15_000 })
})

test("unhiding the category brings its titles back", async ({ page }) => {
  await seed(page, [])
  await page.goto("/recently-added")
  await expectVisibleOnly(page, [101, 102, 201, 202], [])
})
