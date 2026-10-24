/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest"
import {
  DEFAULT_SUBTITLE_SCALE,
  applySubtitleScaleStyle,
  applyVideoJsSubtitleScale,
  SUBTITLE_SCALE_SIZES,
  migrateSubtitleScale,
  normalizeSubtitleScale,
  subtitleCueStyleCss,
  subtitleScaleFactor,
} from "@/scripts/lib/subtitle-scale.ts"

describe("normalizeSubtitleScale", () => {
  it("keeps valid sizes", () => {
    for (const size of SUBTITLE_SCALE_SIZES) expect(normalizeSubtitleScale(size)).toBe(size)
  })

  it("falls back to normal for invalid input", () => {
    expect(normalizeSubtitleScale("huge")).toBe("normal")
    expect(normalizeSubtitleScale(undefined)).toBe("normal")
    expect(normalizeSubtitleScale(null)).toBe("normal")
    expect(normalizeSubtitleScale(3)).toBe("normal")
    expect(DEFAULT_SUBTITLE_SCALE).toBe("normal")
  })
})

describe("subtitleScaleFactor", () => {
  it("maps each size", () => {
    expect(subtitleScaleFactor("small")).toBe(0.8)
    expect(subtitleScaleFactor("normal")).toBe(1)
    expect(subtitleScaleFactor("large")).toBe(1.25)
    expect(subtitleScaleFactor("xlarge")).toBe(1.5)
  })
})

describe("subtitleCueStyleCss", () => {
  it("emits the cue font-size rule", () => {
    expect(subtitleCueStyleCss("large")).toBe("video::cue { font-size: 125%; }")
    expect(subtitleCueStyleCss("small")).toContain("80%")
  })
})

describe("migrateSubtitleScale", () => {
  it("prefers a valid stored scale", () => {
    expect(migrateSubtitleScale("small", JSON.stringify({ size: "large" }))).toBe("small")
  })

  it("reads the legacy mpv style size when unset", () => {
    expect(migrateSubtitleScale(null, JSON.stringify({ size: "large" }))).toBe("large")
    expect(migrateSubtitleScale(null, JSON.stringify({ size: "normal" }))).toBe("normal")
  })

  it("ignores an invalid stored scale and garbage JSON", () => {
    expect(migrateSubtitleScale("bogus", JSON.stringify({ size: "xlarge" }))).toBe("xlarge")
    expect(migrateSubtitleScale(null, "not json")).toBe("normal")
    expect(migrateSubtitleScale(null, null)).toBe("normal")
  })
})

describe("applySubtitleScaleStyle", () => {
  it("creates the style once and updates it in place", () => {
    applySubtitleScaleStyle("large")
    applySubtitleScaleStyle("small")
    const styles = document.querySelectorAll("#xt-subtitle-scale-style")
    expect(styles).toHaveLength(1)
    expect(styles[0].textContent).toBe("video::cue { font-size: 80%; }")
  })
})

describe("applyVideoJsSubtitleScale", () => {
  function fakePlayer() {
    const select = document.createElement("select")
    for (const value of ["0.50", "0.75", "1.00", "1.25", "1.50", "1.75", "2.00", "3.00", "4.00"]) {
      const option = document.createElement("option")
      option.value = value
      select.appendChild(option)
    }
    const updateDisplay = vi.fn()
    return { select, updateDisplay, player: { textTrackSettings: { $: () => select, updateDisplay } } }
  }

  it("picks the video.js option for each size and repaints", () => {
    const { select, updateDisplay, player } = fakePlayer()
    applyVideoJsSubtitleScale(player, "normal")
    expect(select.value).toBe("1.00")
    applyVideoJsSubtitleScale(player, "small")
    expect(select.value).toBe("0.75")
    expect(updateDisplay).toHaveBeenCalledTimes(2)
  })

  it("is a no-op without text track settings", () => {
    expect(() => applyVideoJsSubtitleScale({}, "large")).not.toThrow()
    expect(() => applyVideoJsSubtitleScale(null, "large")).not.toThrow()
  })
})
