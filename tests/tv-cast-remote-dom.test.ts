/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const session = {
  deviceId: "d1",
  deviceName: "Living room TV",
  host: "10.0.0.5",
  port: 8009,
  key: "k",
  title: "Sky Sport 1",
  isLive: true,
  startedAtMs: Date.now() - 60_000,
  startedAt: Date.now() - 60_000,
  logo: "",
  contentHref: "/livetv?channel=1",
  liveContext: { playlistId: "p1", channelIds: ["1", "2"], index: 0 },
}

const castStopMock = vi.fn(async () => true)
const castRetryLastMock = vi.fn(async () => true)
let feedListener: ((state: any) => void) | null = null

vi.mock("@/scripts/lib/tv-cast.js", () => ({
  getCastSession: () => session,
  castPause: vi.fn(async () => true),
  castResume: vi.fn(async () => true),
  castSeek: vi.fn(async () => true),
  castStop: (...args: unknown[]) => castStopMock(...(args as [])),
  castRetryLast: (...args: unknown[]) => castRetryLastMock(...(args as [])),
  castSetVolume: vi.fn(async () => true),
  isCastPlaySettling: () => false,
  sessionAsDevice: (input: unknown) => input,
  getReceiverLogTail: () => ["line one"],
  CAST_SESSION_EVENT: "xt:cast-session",
}))
vi.mock("@/scripts/lib/tv-cast-state-feed.js", () => ({
  subscribeCastStateFeed: (onState: (state: any) => void) => {
    feedListener = onState
    return () => {
      feedListener = null
    }
  },
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

import { openCastRemote } from "@/scripts/lib/tv-cast-remote"

function role<T extends HTMLElement>(name: string): T {
  return document.querySelector<T>(`#tv-cast-remote [data-role="${name}"]`)!
}

/** The picker entry resolves through dynamic imports; give them real task turns. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function pushState(state: Record<string, unknown>): void {
  feedListener?.({ positionSeconds: 0, ...state })
}

beforeEach(() => {
  castStopMock.mockClear()
  castRetryLastMock.mockClear()
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event("close"))
  }
  openCastRemote()
})

afterEach(() => {
  document.getElementById("tv-cast-remote")?.remove()
})

describe("cast remote dialog", () => {
  it("builds every element the controller queries", () => {
    for (const name of [
      "page-now",
      "page-channels",
      "artwork-img",
      "title",
      "state",
      "busy",
      "error-block",
      "retry",
      "scrubber",
      "live-elapsed",
      "playpause",
      "volume-row",
      "footer-stop",
      "picker-entry",
      "poster",
    ]) {
      expect(role(name), name).toBeTruthy()
    }
  })

  it("keeps the transport to five controls with no duplicate seek pair", () => {
    const deck = role("playpause").parentElement!
    const buttons = [...deck.querySelectorAll("button")].map((button) => (button as HTMLElement).dataset.role)
    expect(buttons).toEqual(["prev", "back30", "playpause", "forward30", "next"])
    expect(document.querySelector('[data-role="back10"]')).toBeNull()
  })

  it("hides seek controls for a live session but keeps the elapsed clock labelled", () => {
    expect(role("scrubber").classList.contains("hidden")).toBe(true)
    expect(role("back30").classList.contains("hidden")).toBe(true)
    expect(role("live-elapsed-label").textContent).toBe("cast.remote.liveElapsedLabel")
    expect(role("live-elapsed-value").textContent).toMatch(/\d/)
  })

  it("names the dialog even when nothing has been picked to play", () => {
    expect(role("title").textContent).toBe("Sky Sport 1")
    const labelledBy = document.getElementById("tv-cast-remote")!.getAttribute("aria-labelledby")
    expect(labelledBy).toBe("tv-cast-remote-title")
    expect(role("title").id).toBe("tv-cast-remote-title")
  })

  it("reserves the volume row instead of growing into it", () => {
    expect(role("volume-row").classList.contains("invisible")).toBe(true)
    pushState({ state: "playing", volume: 0.5, muted: false })
    expect(role("volume-row").classList.contains("invisible")).toBe(false)
    expect(role<HTMLInputElement>("volume-range").value).toBe("0.5")
  })

  it("says loading rather than playing while the receiver is buffering", () => {
    pushState({ state: "buffering" })
    expect(role("state").textContent).toBe("cast.remote.stateBuffering")
    expect(role("busy").classList.contains("hidden")).toBe(false)

    pushState({ state: "playing" })
    expect(role("state").textContent).toBe("cast.remote.statePlaying")
    expect(role("busy").classList.contains("hidden")).toBe(true)
  })

  it("surfaces the error in an alert region with a retry action", () => {
    pushState({ state: "error", error: "boom" })
    expect(role("error-block").classList.contains("hidden")).toBe(false)
    expect(role("error-line").getAttribute("role")).toBe("alert")
    expect(role("error-line").textContent).toBe("cast.remote.errorDetail")
    expect(role("error-log-text").textContent).toBe("line one")

    role<HTMLButtonElement>("retry").click()
    expect(castRetryLastMock).toHaveBeenCalled()
  })

  it("requires two presses to stop casting, like the pill", () => {
    const stop = role<HTMLButtonElement>("footer-stop")
    stop.click()
    expect(castStopMock).not.toHaveBeenCalled()
    expect(stop.textContent).toBe("cast.pill.stopConfirmLabel")

    stop.click()
    expect(castStopMock).toHaveBeenCalledTimes(1)
  })

  it("disarms a pending stop when the user touches anything else", () => {
    const stop = role<HTMLButtonElement>("footer-stop")
    stop.click()
    role<HTMLButtonElement>("playpause").click()
    expect(stop.textContent).toBe("cast.pill.stop")
    stop.click()
    expect(castStopMock).not.toHaveBeenCalled()
  })

  it("offers no More/Less control when nothing is clipped", () => {
    const plotBtn = role<HTMLButtonElement>("metadata-plot-btn")
    expect(plotBtn.disabled).toBe(true)
    expect(role("metadata-plot-toggle").classList.contains("hidden")).toBe(true)
    plotBtn.click()
    expect(plotBtn.getAttribute("aria-expanded")).toBe("false")
  })

  it("expands and collapses once the plot is long enough to clip", () => {
    const plotBtn = role<HTMLButtonElement>("metadata-plot-btn")
    // What applyPlot's measurement does when the clamp is hiding lines.
    plotBtn.disabled = false
    role("metadata-plot-toggle").classList.remove("hidden")

    plotBtn.click()
    expect(plotBtn.getAttribute("aria-expanded")).toBe("true")
    expect(role("metadata-plot-toggle").textContent).toBe("cast.remote.plotLess")
    expect(role("metadata-plot").classList.contains("line-clamp-3")).toBe(false)

    plotBtn.click()
    expect(plotBtn.getAttribute("aria-expanded")).toBe("false")
    expect(role("metadata-plot-toggle").textContent).toBe("cast.remote.plotMore")
    expect(role("metadata-plot").classList.contains("line-clamp-3")).toBe(true)
  })

  it("shows the channel picker for a live session and no poster", async () => {
    await settle()
    expect(role("picker-entry").classList.contains("hidden")).toBe(false)
    expect(role("picker-entry-label").textContent).toBe("cast.remote.channels")
    expect(role("poster").classList.contains("hidden")).toBe(true)
  })

  it("pins the control deck outside the scrolling region", () => {
    const scrollArea = role("metadata").parentElement!
    expect(scrollArea.className).toContain("overflow-y-auto")
    const deck = role("playpause").parentElement!.parentElement!
    expect(deck.className).toContain("shrink-0")
    expect(deck.closest(".overflow-y-auto")).toBeNull()
    expect(role("footer-stop").closest(".overflow-y-auto")).toBeNull()
  })

  it("says what prev/next will move to instead of just Previous/Next", () => {
    expect(role("next").getAttribute("aria-label")).toBe("cast.remote.nextChannel (N)")
    expect(role("prev").getAttribute("aria-label")).toBe("cast.remote.previousChannel (P)")
  })

  it("adapts the footer actions for short viewports", () => {
    const footer = role("footer-stop").parentElement!
    expect(footer.className).toContain("short-viewport:flex-row")
  })
})
