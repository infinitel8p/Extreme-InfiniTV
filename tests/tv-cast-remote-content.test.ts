/**
 * @vitest-environment jsdom
 *
 * What the remote offers depends on what is casting: a channel list for live, an episode
 * list for a series, neither for a single movie. Movies and series also get their poster.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

type SessionShape = Record<string, unknown>

const BASE = {
  deviceId: "d1",
  deviceName: "Living room TV",
  host: "10.0.0.5",
  port: 8009,
  key: "k",
  startedAtMs: Date.now() - 60_000,
  startedAt: Date.now() - 60_000,
  logo: "https://example.invalid/poster.jpg",
}

let session: SessionShape = { ...BASE }

vi.mock("@/scripts/lib/tv-cast.js", () => ({
  getCastSession: () => session,
  castPause: vi.fn(async () => true),
  castResume: vi.fn(async () => true),
  castSeek: vi.fn(async () => true),
  castStop: vi.fn(async () => true),
  castRetryLast: vi.fn(async () => true),
  castSetVolume: vi.fn(async () => true),
  isCastPlaySettling: () => false,
  sessionAsDevice: (input: unknown) => input,
  getReceiverLogTail: () => [],
  CAST_SESSION_EVENT: "xt:cast-session",
}))
vi.mock("@/scripts/lib/tv-cast-state-feed.js", () => ({
  subscribeCastStateFeed: () => () => {},
  pokeCastStateFeed: vi.fn(),
  createIdleTeardownGuard: () => ({ allowsTeardown: () => false }),
}))
vi.mock("@/scripts/lib/tv-cast-next.js", () => ({
  castNeighbor: vi.fn(async () => true),
  neighborAvailability: () => ({ previous: true, next: true }),
  resolveNeighborAvailability: async () => ({ previous: true, next: true }),
}))
vi.mock("@/scripts/lib/dialog-spatial-nav.js", () => ({ attachDialogSpatialNav: vi.fn() }))
vi.mock("@/scripts/lib/i18n.js", () => ({ t: (key: string) => key, LOCALE_EVENT: "xt:locale-changed" }))
vi.mock("@/scripts/lib/toast.js", () => ({ toast: vi.fn() }))
vi.mock("@/scripts/lib/account-info.js", () => ({ getActivePlaylistIdSync: () => "p1" }))

import { openCastRemote } from "@/scripts/lib/tv-cast-remote"

function role<T extends HTMLElement>(name: string): T {
  return document.querySelector<T>(`#tv-cast-remote [data-role="${name}"]`)!
}

async function openWith(patch: SessionShape): Promise<void> {
  session = { ...BASE, ...patch }
  openCastRemote()
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event("close"))
  }
})

afterEach(() => {
  document.getElementById("tv-cast-remote")?.remove()
})

describe("what the remote offers per content type", () => {
  it("gives a live channel a channel picker and no poster", async () => {
    await openWith({
      title: "Sky Sport 1",
      isLive: true,
      liveContext: { playlistId: "p1", channelIds: ["1", "2"], index: 0 },
    })
    expect(role("picker-entry").classList.contains("hidden")).toBe(false)
    expect(role("picker-entry-label").textContent).toBe("cast.remote.channels")
    expect(role("poster").classList.contains("hidden")).toBe(true)
    expect(role("artwork").classList.contains("hidden")).toBe(false)
  })

  it("gives a series an episode picker, not a channel list", async () => {
    await openWith({
      title: "Unglaubliche Geschichten S1E1",
      isLive: false,
      seriesContext: { playlistId: "p1", seriesId: "s9", season: 1, episodeNum: 1 },
    })
    expect(role("picker-entry").classList.contains("hidden")).toBe(false)
    expect(role("picker-entry-label").textContent).toBe("detail.section.episodes")
  })

  it("gives a movie no picker at all", async () => {
    await openWith({
      title: "Some Movie",
      isLive: false,
      vodContext: { playlistId: "p1", vodId: 42 },
    })
    expect(role("picker-entry").classList.contains("hidden")).toBe(true)
  })

  it("shows the poster for a series and steps the header thumbnail aside", async () => {
    await openWith({
      title: "Unglaubliche Geschichten S1E1",
      isLive: false,
      seriesContext: { playlistId: "p1", seriesId: "s9", season: 1, episodeNum: 1 },
    })
    expect(role("poster").classList.contains("hidden")).toBe(false)
    expect(role<HTMLImageElement>("poster-img").getAttribute("src")).toBe(BASE.logo)
    const artwork = role("artwork")
    expect(artwork.classList.contains("hidden")).toBe(true)
    // ...but comes back where the poster is suppressed for height.
    expect(artwork.classList.contains("short-viewport:grid")).toBe(true)
  })

  it("shows the poster for a movie", async () => {
    await openWith({ title: "Some Movie", isLive: false, vodContext: { playlistId: "p1", vodId: 42 } })
    expect(role("poster").classList.contains("hidden")).toBe(false)
  })

  it("keeps the poster out of the layout when the session has no artwork", async () => {
    await openWith({ title: "Some Movie", isLive: false, logo: "", vodContext: { playlistId: "p1", vodId: 42 } })
    expect(role("poster").classList.contains("hidden")).toBe(true)
    expect(role<HTMLImageElement>("poster-img").hasAttribute("src")).toBe(false)
  })
})
