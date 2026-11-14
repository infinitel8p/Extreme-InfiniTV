// #227: a provider 403 on a quick return to a just-left live channel is retried with backoff.
import { test, expect, type Page } from "@playwright/test"

const PLAYLIST_ID = "pl-quick-return"
const BUSY_TOAST = "Provider is busy - retrying…"
const FAILURE_TITLE = "Can't play this channel"
const LINGER_MS = 4000

const CHANNELS = [
  { id: 1, name: "Alpha One" },
  { id: 2, name: "Bravo Two" },
  { id: 3, name: "Charlie Three" },
]

const MANIFEST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXTINF:4.0,",
  "seg0.ts",
  "#EXTINF:4.0,",
  "seg1.ts",
  "#EXTINF:4.0,",
  "seg2.ts",
  "",
].join("\n")

type ManifestMode = "linger" | "always403"

interface StreamMock {
  manifestRequests: Record<number, { at: number; status: number }[]>
}

async function seed(page: Page, mode: ManifestMode): Promise<StreamMock> {
  const mock: StreamMock = { manifestRequests: { 1: [], 2: [], 3: [] } }
  let aServed = false
  let lingerUntil = 0

  await page.context().addInitScript(
    (playlists) => {
      try {
        localStorage.setItem("xt_locale", "en")
        localStorage.setItem("xt_theme", "dark")
        localStorage.setItem("xt_perf_mode", "1")
        localStorage.setItem("xt_last_seen_version", "99.0.0")
        if (!localStorage.getItem("xt_playlists")) localStorage.setItem("xt_playlists", JSON.stringify(playlists))
      } catch {}
      try {
        sessionStorage.setItem("xt_splash_done", "1")
      } catch {}
    },
    {
      entries: [
        {
          _id: PLAYLIST_ID,
          type: "xtream",
          serverUrl: "https://q.fixtures.invalid",
          username: "user",
          password: "pass",
          title: "Q",
          addedAt: 1,
          lastUsedAt: 1,
        },
      ],
      selectedId: PLAYLIST_ID,
    }
  )

  await page.context().route("https://api.github.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  )
  await page.context().route(/^https:\/\/q\.fixtures\.invalid\//, (route) => {
    const url = new URL(route.request().url())
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })

    const manifestMatch = /^\/live\/user\/pass\/(\d+)\.m3u8$/.exec(url.pathname)
    if (manifestMatch) {
      const channelId = Number(manifestMatch[1])
      const now = Date.now()
      if (channelId === 2 && aServed && lingerUntil === 0) lingerUntil = now + LINGER_MS
      let status = 200
      if (channelId === 1) {
        if (mode === "always403") status = 403
        else if (now < lingerUntil) status = 403
        if (status === 200) aServed = true
      }
      mock.manifestRequests[channelId]?.push({ at: now, status })
      if (status === 403) return route.fulfill({ status: 403, contentType: "text/plain", body: "forbidden" })
      return route.fulfill({ status: 200, contentType: "application/vnd.apple.mpegurl", body: MANIFEST })
    }
    if (/\.ts$/.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: "video/mp2t", body: Buffer.alloc(188, 0) })
    }

    const action = url.searchParams.get("action") || ""
    if (action === "get_live_categories") return json([{ category_id: "1", category_name: "General", parent_id: 0 }])
    if (action === "get_live_streams") {
      return json(
        CHANNELS.map((channel, index) => ({
          num: index + 1,
          name: channel.name,
          stream_id: channel.id,
          category_id: "1",
          stream_icon: "",
          epg_channel_id: "",
        }))
      )
    }
    if (action === "get_vod_categories" || action === "get_vod_streams" || action === "get_series_categories" || action === "get_series") {
      return json([])
    }
    return json({ user_info: { auth: 1, status: "Active", max_connections: "1" }, server_info: {} })
  })

  return mock
}

const tune = (page: Page, name: string) =>
  page.locator(".channel-row", { hasText: name }).locator("[data-role='play']").click()

const failurePanel = (page: Page) => page.locator("[data-playback-failure]")
const busyToast = (page: Page) => page.getByText(BUSY_TOAST)

async function waitForManifest(mock: StreamMock, channelId: number, minimumCount = 1): Promise<void> {
  await expect.poll(() => mock.manifestRequests[channelId].length, { timeout: 15_000 }).toBeGreaterThanOrEqual(minimumCount)
}

async function quickReturnToFirstRejection(page: Page, mock: StreamMock): Promise<number> {
  await page.goto("/livetv")
  await expect(page.locator(".channel-row", { hasText: "Alpha One" })).toBeVisible({ timeout: 15_000 })
  await tune(page, "Alpha One")
  await waitForManifest(mock, 1)
  await tune(page, "Bravo Two")
  await waitForManifest(mock, 2)
  const requestsBeforeReturn = mock.manifestRequests[1].length
  await tune(page, "Alpha One")
  await expect
    .poll(() => mock.manifestRequests[1].filter((request) => request.status === 403).length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1)
  return requestsBeforeReturn
}

test("quick return after a provider 403 recovers through spaced retries", async ({ page }) => {
  const mock = await seed(page, "linger")
  const requestsBeforeReturn = await quickReturnToFirstRejection(page, mock)
  const returnedAt = Date.now()

  await expect(busyToast(page).first()).toBeVisible({ timeout: 5000 })

  await expect
    .poll(() => mock.manifestRequests[1].slice(requestsBeforeReturn).filter((request) => request.status === 200).length, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(1)

  const returnRequests = mock.manifestRequests[1].slice(requestsBeforeReturn)
  const timeline = returnRequests.map((request) => `${request.at - returnRequests[0].at}ms:${request.status}`)
  console.log("A timeline after return:", timeline.join(" "))

  const rejected = returnRequests.filter((request) => request.status === 403)
  expect(rejected.length).toBeGreaterThanOrEqual(2)
  const retries = returnRequests.slice(1)
  expect(retries.length).toBeGreaterThanOrEqual(2)
  expect(Math.abs(retries[0].at - returnRequests[0].at - 2000)).toBeLessThan(700)
  expect(Math.abs(retries[1].at - retries[0].at - 3000)).toBeLessThan(700)

  await page.waitForTimeout(Math.max(0, returnedAt + 12_000 - Date.now()))
  await expect(failurePanel(page)).toHaveCount(0)
  await expect(page.getByText(FAILURE_TITLE)).toHaveCount(0)
})

test("a 403 on a fresh tune fails fast without the busy toast", async ({ page }) => {
  const mock = await seed(page, "always403")
  let busyToastSeen = false
  await page.exposeFunction("markBusyToast", () => {
    busyToastSeen = true
  })
  await page.addInitScript((text) => {
    new MutationObserver(() => {
      if (document.body?.textContent?.includes(text)) (window as any).markBusyToast()
    }).observe(document, { childList: true, subtree: true, characterData: true })
  }, BUSY_TOAST)

  await page.goto("/livetv")
  await expect(page.locator(".channel-row", { hasText: "Alpha One" })).toBeVisible({ timeout: 15_000 })
  const tunedAt = Date.now()
  await tune(page, "Alpha One")
  await waitForManifest(mock, 1)
  const firstAt = mock.manifestRequests[1][0].at

  await expect(failurePanel(page)).toBeVisible({ timeout: 5000 })
  expect(Date.now() - tunedAt).toBeLessThan(6000)

  await page.waitForTimeout(Math.max(0, firstAt + 4000 - Date.now()))
  const requests = mock.manifestRequests[1]
  expect(requests.filter((request) => request.at < firstAt + 1000)).toHaveLength(1)
  expect(Math.abs(requests[1].at - requests[0].at - 1500)).toBeLessThan(700)
  expect(requests.every((request) => request.at < requests[1].at + 500)).toBe(true)
  expect(busyToastSeen).toBe(false)
})

test("tuning another channel cancels pending quick-return retries", async ({ page }) => {
  const mock = await seed(page, "linger")
  await quickReturnToFirstRejection(page, mock)

  await page.waitForTimeout(500)
  await tune(page, "Charlie Three")
  await waitForManifest(mock, 3)

  const countAfterSwitch = mock.manifestRequests[1].length
  await page.waitForTimeout(6000)
  expect(mock.manifestRequests[1].length).toBe(countAfterSwitch)
})
