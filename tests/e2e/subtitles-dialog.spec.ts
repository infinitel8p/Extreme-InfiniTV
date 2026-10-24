// #236: in-player "Subtitles" control opens the shared size/delay dialog on every embedded backend.
import { test, expect, type Locator, type Page } from "@playwright/test"

const PLAYLIST_ID = "pl-subs"
const MOVIE_ID = 101
const BACKENDS = ["videojs", "artplayer", "shaka"] as const
type Backend = (typeof BACKENDS)[number]
// 30s black 16x16 VP8: Playwright Chromium has no H.264, and the control bars only show once playback starts.
const FIXTURE_WEBM = Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAUdEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggUH7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMESJiEDdTAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYiNVrqwnx5uIZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhDuaygDgkLCBELqBEJqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAwc3PWY8CLY8WIjVa6sJ8ebiFnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjMwLjAwMDAwMDAwMAAfQ7Z1QK/ngQCjo4EAAIAQAgCdASoQABAAAEcIhYWImYSIAgIADA1gAP7/q1CAo5mBA+gAsQEAARAQABgAMD/0DAAAAP7/q1CAo5mBB9AAsQEAARAQABgAMD/0DAAAAP7/q1CAo5mBC7gAsQEAARAQABgAMD/0DAAAAP7/q1CAo5mBD6AAsQEAARAQABgAMD/0DAAAAP7/q1CAo5mBE4gAsQEAARAQABgAMD/0DAAAAP7/q1CAH0O2dUCl54IXcKOZgQAAALEBAAEQEAAYADA/9AwAAAD+/6tQgKOYgQPoAJEBAAEQEBRgAMD/0DAAAP7/q1CAo5mBB9AAsQEAARAQABgAMD/0DAAAAP7/q1CAo5mBC7gAsQEAARAQABgAMD/0DAAAAP7/q1CAo5mBD6AAsQEAARAQABgAMD/0DAAAAP7/q1CAo5mBE4gAsQEAARAQABgAMD/0DAAAAP7/q1CAH0O2dUCl54Iu4KOZgQAAALEBAAEQEAAYADA/9AwAAAD+/6tQgKOZgQPoALEBAAEQEAAYADA/9AwAAAD+/6tQgKOYgQfQAJEBAAEQEBRgAMD/0DAAAP7/q1CAo5mBC7gAsQEAARAQABgAMD/0DAAAAP7/q1CAo5mBD6AAsQEAARAQABgAMD/0DAAAAP7/q1CAo5mBE4gAsQEAARAQABgAMD/0DAAAAP7/q1CAH0O2dUCl54JGUKOZgQAAALEBAAEQEAAYADA/9AwAAAD+/6tQgKOZgQPoALEBAAEQEAAYADA/9AwAAAD+/6tQgKOZgQfQALEBAAEQEAAYADA/9AwAAAD+/6tQgKOYgQu4AJEBAAEQEBRgAMD/0DAAAP7/q1CAo5mBD6AAsQEAARAQABgAMD/0DAAAAP7/q1CAo5mBE4gAsQEAARAQABgAMD/0DAAAAP7/q1CAH0O2dUCl54JdwKOZgQAAALEBAAEQEAAYADA/9AwAAAD+/6tQgKOZgQPoALEBAAEQEAAYADA/9AwAAAD+/6tQgKOZgQfQALEBAAEQEAAYADA/9AwAAAD+/6tQgKOZgQu4ALEBAAEQEAAYADA/9AwAAAD+/6tQgKOYgQ+gAJEBAAEQEBRgAMD/0DAAAP7/q1CAo5mBE4gAsQEAARAQABgAMD/0DAAAAP7/q1CAHFO7a5G7j7OBALeK94EB8YIBpvCBAw==",
  "base64"
)

async function seed(page: Page, backend: Backend): Promise<void> {
  const playlists = {
    entries: [
      {
        _id: PLAYLIST_ID,
        type: "xtream",
        serverUrl: "https://s.fixtures.invalid",
        username: "user",
        password: "pass",
        title: "S",
        addedAt: 1,
        lastUsedAt: 1,
      },
    ],
    selectedId: PLAYLIST_ID,
  }
  await page.context().addInitScript(
    ({ state, playerBackend }) => {
      try {
        localStorage.setItem("xt_locale", "en")
        localStorage.setItem("xt_theme", "dark")
        localStorage.setItem("xt_perf_mode", "1")
        localStorage.setItem("xt_last_seen_version", "99.0.0")
        localStorage.setItem("xt_player_backend", playerBackend)
        if (!localStorage.getItem("xt_playlists")) localStorage.setItem("xt_playlists", JSON.stringify(state))
      } catch {}
      try {
        sessionStorage.setItem("xt_splash_done", "1")
      } catch {}
    },
    { state: playlists, playerBackend: backend }
  )

  await page.context().route("https://api.github.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  )
  await page.context().route(/^https:\/\/s\.fixtures\.invalid\//, (route) => {
    const url = new URL(route.request().url())
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
    if (url.pathname.startsWith("/movie/")) return route.fulfill({ status: 200, contentType: "video/webm", body: FIXTURE_WEBM })
    const action = url.searchParams.get("action") || ""
    if (action === "get_vod_categories") return json([{ category_id: "1", category_name: "Action", parent_id: 0 }])
    if (action === "get_vod_streams") {
      return json([
        { num: 1, name: "Subs Movie", stream_id: MOVIE_ID, category_id: "1", container_extension: "mp4", added: "1700000000" },
      ])
    }
    if (action === "get_vod_info") {
      return json({
        info: { name: "Subs Movie", plot: "Plot", releasedate: "2020-01-01" },
        movie_data: { stream_id: MOVIE_ID, name: "Subs Movie", container_extension: "mp4" },
      })
    }
    if (action === "get_series_categories" || action === "get_series") return json([])
    return json({ user_info: { auth: 1, status: "Active", max_connections: "1" }, server_info: {} })
  })
}

const FULLSCREEN_SELECTOR: Record<Backend, string> = {
  videojs: ".vjs-fullscreen-control",
  artplayer: ".art-control-fullscreen",
  shaka: ".shaka-fullscreen-button",
}

function subtitlesControl(page: Page, backend: Backend): Locator {
  if (backend === "videojs") return page.locator(".vjs-control-bar .vjs-xt-subtitles-button")
  if (backend === "artplayer") return page.locator(".art-controls .art-control-xtSubtitlesDialog")
  return page.locator(".shaka-controls-container button.shaka-xt-subtitles-button")
}

async function startPlayback(page: Page): Promise<void> {
  await page.goto(`/movies/detail?id=${MOVIE_ID}&pl=${PLAYLIST_ID}`)
  await expect(page.locator("#movie-detail-title")).toContainText("Subs Movie")
  await page.locator("#movie-detail-play").click()
  await expect(page.locator("#movie-detail-player-wrap")).toBeVisible({ timeout: 15_000 })
}

const subtitlesDialog = (page: Page) => page.locator("dialog#movie-subtitle-delay-dialog[open]")

for (const backend of BACKENDS) {
  test(`${backend}: Subtitles control opens the dialog and sets the size`, async ({ page }) => {
    await seed(page, backend)
    await startPlayback(page)

    const control = subtitlesControl(page, backend)
    await expect(control).toHaveCount(1, { timeout: 15_000 })
    if (backend === "artplayer") {
      await expect(page.locator(".art-controls-right .art-control-xtSubtitlesDialog")).toHaveCount(1)
    } else {
      expect(await control.evaluate((el, selector) => !!el.nextElementSibling?.matches(selector), FULLSCREEN_SELECTOR[backend])).toBe(true)
    }
    await page.locator("#movie-detail-player-wrap").hover()
    await control.click()

    const dialog = subtitlesDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-role="title"]')).toHaveText("Subtitles")
    await expect(dialog.locator('[data-role="delay-section"]')).toHaveAttribute("aria-disabled", "true")
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("dialog[open]"))).toBe(true)

    const large = dialog.locator('[role="radiogroup"] [data-size="large"]')
    await expect(large).toHaveText("Large")
    await large.click()
    await expect(large).toHaveAttribute("aria-checked", "true")
    await expect(dialog.locator('[data-size="normal"]')).toHaveAttribute("aria-checked", "false")
    expect(await page.evaluate(() => localStorage.getItem("xt_subs_scale"))).toBe("large")
    await expect.poll(() => page.evaluate(() => document.getElementById("xt-subtitle-scale-style")?.textContent ?? "")).toContain("125%")

    await page.keyboard.press("Escape")
    await expect(page.locator("dialog[open]")).toHaveCount(0)
  })
}

for (const backend of BACKENDS) {
  test(`${backend}: Subtitles dialog opens above fullscreen without leaving it`, async ({ page }) => {
    await seed(page, backend)
    await startPlayback(page)

    const control = subtitlesControl(page, backend)
    await expect(control).toHaveCount(1, { timeout: 15_000 })
    await page.locator("#movie-detail-player-wrap").hover()
    await page.locator(FULLSCREEN_SELECTOR[backend]).first().click()
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)

    await page.mouse.move(400, 400)
    await page.mouse.move(420, 420)
    await control.click()
    await expect(subtitlesDialog(page)).toBeVisible()
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("dialog[open]"))).toBe(true)
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    const dialogIsTopmost = await page.evaluate(() => {
      const dialog = document.querySelector("dialog[open]") as HTMLElement
      const rect = dialog.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return !!hit && dialog.contains(hit)
    })
    expect(dialogIsTopmost).toBe(true)

    await subtitlesDialog(page).locator('[data-size="xlarge"]').click()
    expect(await page.evaluate(() => localStorage.getItem("xt_subs_scale"))).toBe("xlarge")
    await subtitlesDialog(page).locator('[data-role="close"]').click()
    await expect(page.locator("dialog[open]")).toHaveCount(0)
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  })
}
