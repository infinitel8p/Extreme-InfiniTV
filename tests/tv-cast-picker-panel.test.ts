/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const castLiveChannelMock = vi.fn(async () => true)
const castSeriesEpisodeMock = vi.fn(async () => true)
const readCachedLiveChannelsMock = vi.fn()

const EPISODES = [
  { season: 1, episodeNum: 1, id: 11, title: "Pilot" },
  { season: 1, episodeNum: 2, id: 12, title: "Second" },
  { season: 2, episodeNum: 1, id: 21, title: "Return" },
]

vi.mock("@/scripts/lib/tv-cast-live.js", () => ({
  castLiveChannel: (...args: unknown[]) => castLiveChannelMock(...(args as [])),
  resolvePlaylistCreds: async () => null,
}))
vi.mock("@/scripts/lib/tv-cast-episode.js", () => ({
  castSeriesEpisode: (...args: unknown[]) => castSeriesEpisodeMock(...(args as [])),
  loadSeriesEpisodes: async () => EPISODES,
}))
vi.mock("@/scripts/lib/live-catalog.ts", () => ({
  readCachedLiveChannels: (...args: unknown[]) => readCachedLiveChannelsMock(...(args as [])),
}))
vi.mock("@/scripts/lib/catalog.js", () => ({ ensureLive: async () => [] }))
vi.mock("@/scripts/lib/i18n.js", () => ({ t: (key: string) => key, LOCALE_EVENT: "xt:locale-changed" }))
vi.mock("@/scripts/lib/toast.js", () => ({ toast: vi.fn() }))
vi.mock("@/scripts/lib/logo-fallback.js", () => ({ requestLogoFallback: vi.fn() }))
vi.mock("@/scripts/lib/epg-data.js", () => ({
  getProgrammesSync: () => null,
  getNowNextForChannel: () => ({ current: null, next: null }),
}))
vi.mock("@/scripts/lib/preferences.js", () => ({
  getFavorites: () => new Set([2]),
  getHiddenCategories: () => new Set<string>(),
  getAllowedCategories: () => new Set<string>(),
  getCategoryMode: () => "hide",
  getCategorySort: () => "default",
  getViewSort: () => "default",
}))

import { mountCastPickerPanel, type CastPickerPanelHandle } from "@/scripts/lib/tv-cast-picker-panel"
import { createChannelPickerSource, createEpisodePickerSource } from "@/scripts/lib/tv-cast-picker-sources"

const CATALOG = [
  { id: 1, name: "Sky Sport 1", category: "Sports" },
  { id: 2, name: "ARD", category: "News" },
  { id: 3, name: "Sky Cinema", category: "Movies" },
]

let container: HTMLElement
let panel: CastPickerPanelHandle
let onBack: () => void
let onTuneEnd: (ok: boolean) => void

function rows(selector: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(selector)]
}

function rowLabels(): string[] {
  return rows("[data-group-key], [data-item-id]").map((row) => row.textContent?.trim() || "")
}

/** The panel loads through dynamic imports, so a few real task turns are needed. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(async () => {
  castLiveChannelMock.mockClear()
  readCachedLiveChannelsMock.mockReturnValue(CATALOG)
  container = document.createElement("div")
  document.body.appendChild(container)
  onBack = vi.fn<() => void>()
  onTuneEnd = vi.fn<(ok: boolean) => void>()
  panel = mountCastPickerPanel(container, {
    source: createChannelPickerSource({ playlistId: "p1", getPlayingChannelId: () => "2" }),
    onBack,
    onTuneStart: vi.fn<() => void>(),
    onTuneEnd,
  })
  await settle()
})

afterEach(() => {
  panel.destroy()
  container.remove()
})

describe("cast picker panel: channels", () => {
  it("opens on the group list with favorites and all channels first", () => {
    const groups = rows("[data-group-key]").map((row) => row.dataset.groupKey)
    expect(groups).toEqual(["__favorites__", "__all__", "Sports", "News", "Movies"])
  })

  it("drills into a group and lists its channels", () => {
    rows("[data-group-key]")[2].click()
    expect(rows("[data-item-id]").map((row) => row.dataset.itemId)).toEqual(["1"])
    expect(container.querySelector('[data-role="panel-heading"]')?.textContent).toBe("Sports")
  })

  it("marks the channel currently on the receiver", () => {
    rows("[data-group-key]")[1].click()
    const playing = rows("[data-item-id]").filter((row) => row.dataset.nowPlaying === "true")
    expect(playing.map((row) => row.dataset.itemId)).toEqual(["2"])
  })

  it("tunes the clicked channel with the browsed list as its context", async () => {
    rows("[data-group-key]")[1].click()
    rows("[data-item-id]")[2].click()
    await settle()
    expect(castLiveChannelMock).toHaveBeenCalledWith("p1", "3", { groupChannelIds: ["1", "2", "3"] })
    expect(onTuneEnd).toHaveBeenCalledWith(true)
  })

  it("searches the whole catalog from the group level", async () => {
    const search = container.querySelector<HTMLInputElement>('[data-role="panel-search"]')!
    search.value = "sky"
    search.dispatchEvent(new Event("input"))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rows("[data-item-id]").map((row) => row.dataset.itemId)).toEqual(["1", "3"])
  })

  it("steps back from a group to the group list, then hands back to the remote", () => {
    rows("[data-group-key]")[2].click()
    expect(panel.goBack()).toBe(true)
    expect(rowLabels().length).toBe(5)
    expect(panel.goBack()).toBe(false)

    container.querySelector<HTMLButtonElement>('[data-role="panel-back"]')!.click()
    expect(onBack).toHaveBeenCalled()
  })

  it("clears the search before it pops a level", async () => {
    rows("[data-group-key]")[2].click()
    const search = container.querySelector<HTMLInputElement>('[data-role="panel-search"]')!
    search.value = "ard"
    search.dispatchEvent(new Event("input"))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rows("[data-item-id]").map((row) => row.dataset.itemId)).toEqual(["2"])

    expect(panel.goBack()).toBe(true)
    expect(search.value).toBe("")
    expect(rows("[data-item-id]").map((row) => row.dataset.itemId)).toEqual(["1"])
  })

  it("reports an empty catalog instead of rendering an empty list", async () => {
    panel.destroy()
    readCachedLiveChannelsMock.mockReturnValue([])
    panel = mountCastPickerPanel(container, {
      source: createChannelPickerSource({ playlistId: "p1", getPlayingChannelId: () => null }),
      onBack,
      onTuneStart: vi.fn<() => void>(),
      onTuneEnd,
    })
    await settle()
    const status = container.querySelector<HTMLElement>('[data-role="panel-status"]')!
    expect(status.classList.contains("hidden")).toBe(false)
    expect(status.textContent).toBe("cast.remote.channelsEmpty")
  })

  it("renders every row as a button at least 44px tall for touch and D-pad", () => {
    rows("[data-group-key]")[1].click()
    for (const row of rows("[data-item-id]")) {
      expect(row.tagName).toBe("BUTTON")
      expect(row.className).toMatch(/min-h-1[24]/)
    }
  })
})

describe("cast picker panel: episodes", () => {
  let episodePanel: CastPickerPanelHandle

  async function mountEpisodes(playingId: string | null = "1:1"): Promise<void> {
    episodePanel = mountCastPickerPanel(container, {
      source: createEpisodePickerSource({
        playlistId: "p1",
        seriesId: "s9",
        getPlayingEpisodeId: () => playingId,
      }),
      onBack,
      onTuneStart: vi.fn<() => void>(),
      onTuneEnd,
    })
    await settle()
  }

  beforeEach(() => {
    panel.destroy()
    container.replaceChildren()
    castSeriesEpisodeMock.mockClear()
  })

  afterEach(() => episodePanel?.destroy())

  it("opens on the season list", async () => {
    await mountEpisodes()
    expect(rows("[data-group-key]").map((row) => row.dataset.groupKey)).toEqual(["s1", "s2"])
    expect(rows("[data-group-key]")[0].textContent).toContain("series.season")
  })

  it("lists a season's episodes with their SxEy label", async () => {
    await mountEpisodes()
    rows("[data-group-key]")[0].click()
    const items = rows("[data-item-id]")
    expect(items.map((row) => row.dataset.itemId)).toEqual(["1:1", "1:2"])
    expect(items[0].textContent).toContain("Pilot")
    expect(items[0].textContent).toContain("detail.seasonShort")
  })

  it("marks the episode currently on the receiver", async () => {
    await mountEpisodes("1:2")
    rows("[data-group-key]")[0].click()
    const playing = rows("[data-item-id]").filter((row) => row.dataset.nowPlaying === "true")
    expect(playing.map((row) => row.dataset.itemId)).toEqual(["1:2"])
  })

  it("casts the picked episode", async () => {
    await mountEpisodes()
    rows("[data-group-key]")[1].click()
    rows("[data-item-id]")[0].click()
    await settle()
    expect(castSeriesEpisodeMock).toHaveBeenCalledWith("p1", "s9", 2, 1, { entry: EPISODES[2] })
    expect(onTuneEnd).toHaveBeenCalledWith(true)
  })

  it("searches episodes by title across seasons", async () => {
    await mountEpisodes()
    const search = container.querySelector<HTMLInputElement>('[data-role="panel-search"]')!
    search.value = "return"
    search.dispatchEvent(new Event("input"))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rows("[data-item-id]").map((row) => row.dataset.itemId)).toEqual(["2:1"])
  })

  it("shows no logo box for episodes", async () => {
    await mountEpisodes()
    rows("[data-group-key]")[0].click()
    expect(rows("[data-item-id]")[0].querySelector("span.h-10")).toBeNull()
  })
})

