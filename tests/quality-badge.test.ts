/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { attachQualityChip, qualityLabel } from "../src/scripts/lib/quality-badge"

describe("qualityLabel", () => {
  it("returns null for missing or invalid dimensions", () => {
    expect(qualityLabel(null, null)).toBe(null)
    expect(qualityLabel(undefined, undefined)).toBe(null)
    expect(qualityLabel(0, 0)).toBe(null)
    expect(qualityLabel(NaN, NaN)).toBe(null)
    expect(qualityLabel(1920, NaN)).toBe(null)
    expect(qualityLabel(-1920, -1080)).toBe(null)
  })

  it("classifies common renditions", () => {
    expect(qualityLabel(3840, 2160)).toBe("2160p")
    expect(qualityLabel(2560, 1440)).toBe("1440p")
    expect(qualityLabel(1920, 1080)).toBe("1080p")
    expect(qualityLabel(1280, 720)).toBe("720p")
    expect(qualityLabel(1024, 576)).toBe("576p")
    expect(qualityLabel(720, 480)).toBe("480p")
    expect(qualityLabel(640, 360)).toBe("360p")
    expect(qualityLabel(320, 240)).toBe("240p")
  })

  it("classifies letterboxed/anamorphic sources by their effective 16:9 height", () => {
    expect(qualityLabel(1920, 800)).toBe("1080p")
  })

  it("returns null below the lowest bucket", () => {
    expect(qualityLabel(160, 120)).toBe(null)
  })

  it("does not inflate a portrait stream by treating its tall side as the width", () => {
    expect(qualityLabel(608, 1080)).not.toBe("1080p")
    expect(qualityLabel(608, 1080)).toBe("576p")
  })

  it("classifies a portrait stream by its short side, not above its 1080-line", () => {
    expect(qualityLabel(1080, 1920)).toBe("1080p")
  })
})

describe("attachQualityChip", () => {
  function makeVideo(width: number, height: number): HTMLVideoElement {
    const video = document.createElement("video")
    Object.defineProperty(video, "videoWidth", { value: width, configurable: true })
    Object.defineProperty(video, "videoHeight", { value: height, configurable: true })
    return video
  }

  function makeWrap(video: HTMLVideoElement): HTMLElement {
    const wrap = document.createElement("div")
    wrap.appendChild(video)
    document.body.appendChild(wrap)
    return wrap
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ""
  })

  it("returns a no-op detach when the handle has no media element", () => {
    const wrap = document.createElement("div")
    const detach = attachQualityChip(wrap, {})
    expect(() => detach()).not.toThrow()
    expect(wrap.querySelector("[data-quality-chip]")).toBeNull()
  })

  it("shows the chip on loadedmetadata and auto-hides after visibleMs", () => {
    const video = makeVideo(1920, 1080)
    const wrap = makeWrap(video)
    attachQualityChip(wrap, { getMediaElement: () => video }, { visibleMs: 1000 })

    video.dispatchEvent(new Event("loadedmetadata"))
    const chip = wrap.querySelector("[data-quality-chip]")
    expect(chip?.textContent).toBe("1080p")
    expect(chip?.classList.contains("is-leaving")).toBe(false)

    vi.advanceTimersByTime(1000)
    expect(wrap.querySelector("[data-quality-chip]")?.classList.contains("is-leaving")).toBe(true)

    vi.advanceTimersByTime(200)
    expect(wrap.querySelector("[data-quality-chip]")).toBeNull()
  })

  it("does not restart the auto-hide timer for an unchanged label", () => {
    const video = makeVideo(1920, 1080)
    const wrap = makeWrap(video)
    attachQualityChip(wrap, { getMediaElement: () => video }, { visibleMs: 1000 })

    video.dispatchEvent(new Event("loadedmetadata"))
    vi.advanceTimersByTime(500)
    video.dispatchEvent(new Event("resize")) // same 1080p label - should be a no-op
    vi.advanceTimersByTime(500)
    // The original 1000ms timer (never restarted) has now elapsed.
    expect(wrap.querySelector("[data-quality-chip]")?.classList.contains("is-leaving")).toBe(true)
  })

  it("restarts the timer and relabels when the rendition changes", () => {
    const video = makeVideo(1920, 1080)
    const wrap = makeWrap(video)
    attachQualityChip(wrap, { getMediaElement: () => video }, { visibleMs: 1000 })

    video.dispatchEvent(new Event("loadedmetadata"))
    vi.advanceTimersByTime(800)
    Object.defineProperty(video, "videoWidth", { value: 1280, configurable: true })
    Object.defineProperty(video, "videoHeight", { value: 720, configurable: true })
    video.dispatchEvent(new Event("resize"))
    expect(wrap.querySelector("[data-quality-chip]")?.textContent).toBe("720p")

    vi.advanceTimersByTime(800)
    // Still visible: the new label restarted the 1000ms window at t=800.
    expect(wrap.querySelector("[data-quality-chip]")?.classList.contains("is-leaving")).toBe(false)
  })

  it("removes the chip immediately on emptied and re-shows the same label afterwards", () => {
    const video = makeVideo(1920, 1080)
    const wrap = makeWrap(video)
    attachQualityChip(wrap, { getMediaElement: () => video }, { visibleMs: 1000 })

    video.dispatchEvent(new Event("loadedmetadata"))
    expect(wrap.querySelector("[data-quality-chip]")).not.toBeNull()

    video.dispatchEvent(new Event("emptied"))
    expect(wrap.querySelector("[data-quality-chip]")).toBeNull()

    video.dispatchEvent(new Event("loadedmetadata"))
    expect(wrap.querySelector("[data-quality-chip]")?.textContent).toBe("1080p")
  })

  it("shows the chip immediately at attach when the media element already has dimensions", () => {
    const video = makeVideo(1920, 1080)
    const wrap = makeWrap(video)
    attachQualityChip(wrap, { getMediaElement: () => video }, { visibleMs: 1000 })

    expect(wrap.querySelector("[data-quality-chip]")?.textContent).toBe("1080p")
  })

  it("skips showing while a stats overlay is visible", () => {
    const video = makeVideo(1920, 1080)
    const wrap = makeWrap(video)
    const overlay = document.createElement("div")
    overlay.className = "stats-overlay"
    wrap.appendChild(overlay)

    attachQualityChip(wrap, { getMediaElement: () => video }, { visibleMs: 1000 })
    video.dispatchEvent(new Event("loadedmetadata"))
    expect(wrap.querySelector("[data-quality-chip]")).toBeNull()
  })

  it("still shows the chip when the stats overlay element exists but is hidden", () => {
    // attachPlayerInsights builds the overlay eagerly and keeps it in the DOM
    // with the `hidden` attribute, so mere presence must not suppress the chip.
    const video = makeVideo(1920, 1080)
    const wrap = makeWrap(video)
    const overlay = document.createElement("div")
    overlay.className = "stats-overlay"
    overlay.setAttribute("hidden", "")
    wrap.appendChild(overlay)

    attachQualityChip(wrap, { getMediaElement: () => video }, { visibleMs: 1000 })
    video.dispatchEvent(new Event("loadedmetadata"))
    expect(wrap.querySelector("[data-quality-chip]")?.textContent).toBe("1080p")
  })

  it("treats an inline display:none stats overlay as hidden", () => {
    const video = makeVideo(1920, 1080)
    const wrap = makeWrap(video)
    const overlay = document.createElement("div")
    overlay.className = "stats-overlay"
    overlay.style.display = "none"
    wrap.appendChild(overlay)

    attachQualityChip(wrap, { getMediaElement: () => video }, { visibleMs: 1000 })
    expect(wrap.querySelector("[data-quality-chip]")?.textContent).toBe("1080p")

    overlay.style.display = "grid"
    video.dispatchEvent(new Event("emptied"))
    video.dispatchEvent(new Event("loadedmetadata"))
    expect(wrap.querySelector("[data-quality-chip]")).toBeNull()
  })

  it("detach clears timers, listeners, and the chip element", () => {
    const video = makeVideo(1920, 1080)
    const wrap = makeWrap(video)
    const detach = attachQualityChip(wrap, { getMediaElement: () => video }, { visibleMs: 1000 })

    video.dispatchEvent(new Event("loadedmetadata"))
    expect(wrap.querySelector("[data-quality-chip]")).not.toBeNull()

    detach()
    expect(wrap.querySelector("[data-quality-chip]")).toBeNull()

    // Listeners removed: further events must not resurrect the chip.
    video.dispatchEvent(new Event("resize"))
    expect(wrap.querySelector("[data-quality-chip]")).toBeNull()
  })
})
