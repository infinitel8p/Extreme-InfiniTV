import { describe, it, expect } from "vitest"
import {
  cssRectToPhysicalBounds,
  cssRectToNativeVideoHoleVars,
  deriveEvents,
  buildLoadOptions,
  boundsEqual,
  liveEofReloadDelayMs,
  NATIVE_BOUNDS_INFLATE_CSS_PX,
  isWithinOfflinePlaceholderWindow,
  OFFLINE_PLACEHOLDER_WINDOW_MS,
  classifyMpvNetworkError,
  classifyMpvEndFileError,
  parseHttpStatusPrefix,
  clampPlaybackRate,
  sumDroppedFrames,
  shouldReloadForStall,
  LIVE_STALL_THRESHOLD_MS,
  shouldIgnoreEofAfterLiveSeek,
  LIVE_SEEK_EOF_GRACE_MS,
  subtitleStyleToMpvProperties,
  parseSubtitleStyle,
  DEFAULT_MPV_SUBTITLE_STYLE,
  clampAudioDelaySeconds,
  recordingFileName,
} from "../src/scripts/lib/mpv-embedded"

describe("cssRectToPhysicalBounds", () => {
  it("scales a CSS rect by an integer device pixel ratio", () => {
    expect(cssRectToPhysicalBounds({ x: 10, y: 20, width: 300, height: 200 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      radius: 0,
    })
    expect(cssRectToPhysicalBounds({ x: 10, y: 20, width: 300, height: 200 }, 2)).toEqual({
      x: 20,
      y: 40,
      width: 600,
      height: 400,
      radius: 0,
    })
  })

  it("rounds a fractional device pixel ratio to whole physical pixels", () => {
    expect(cssRectToPhysicalBounds({ x: 3, y: 3, width: 111, height: 63 }, 1.5)).toEqual({
      x: 5,
      y: 5,
      width: 167,
      height: 95,
      radius: 0,
    })
    expect(cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 50 }, 1.25)).toEqual({
      x: 0,
      y: 0,
      width: 125,
      height: 63,
      radius: 0,
    })
  })

  it("passes through a zero-size rect", () => {
    expect(cssRectToPhysicalBounds({ x: 0, y: 0, width: 0, height: 0 }, 2)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      radius: 0,
    })
  })

  it("rounds negative coordinates (scrolled offscreen) correctly", () => {
    expect(cssRectToPhysicalBounds({ x: -10.4, y: -20.6, width: 100, height: 100 }, 1)).toEqual({
      x: -10,
      y: -21,
      width: 100,
      height: 100,
      radius: 0,
    })
  })

  it("falls back to a ratio of 1 for an invalid device pixel ratio", () => {
    expect(cssRectToPhysicalBounds({ x: 10, y: 10, width: 100, height: 100 }, 0)).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      radius: 0,
    })
    expect(cssRectToPhysicalBounds({ x: 10, y: 10, width: 100, height: 100 }, NaN)).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      radius: 0,
    })
    expect(cssRectToPhysicalBounds({ x: 10, y: 10, width: 100, height: 100 }, -2)).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      radius: 0,
    })
  })

  it("converts a CSS pixel radius by the device pixel ratio", () => {
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100, radius: "8px" }, 2),
    ).toEqual({ x: 0, y: 0, width: 200, height: 200, radius: 16 })
  })

  it("rounds a fractional device pixel ratio applied to the radius", () => {
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100, radius: "12px" }, 1.5),
    ).toEqual({ x: 0, y: 0, width: 150, height: 150, radius: 18 })
  })

  it("falls back to a radius of 0 for percentages and other non-pixel values", () => {
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100, radius: "50%" }, 2),
    ).toEqual({ x: 0, y: 0, width: 200, height: 200, radius: 0 })
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100, radius: "0px" }, 2),
    ).toEqual({ x: 0, y: 0, width: 200, height: 200, radius: 0 })
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100, radius: "" }, 2),
    ).toEqual({ x: 0, y: 0, width: 200, height: 200, radius: 0 })
  })

  it("inflates the rect on every side by the given CSS px amount before scaling", () => {
    expect(
      cssRectToPhysicalBounds({ x: 10, y: 20, width: 300, height: 200 }, 1, 1),
    ).toEqual({ x: 9, y: 19, width: 302, height: 202, radius: 0 })
    expect(
      cssRectToPhysicalBounds({ x: 10, y: 20, width: 300, height: 200 }, 2, NATIVE_BOUNDS_INFLATE_CSS_PX),
    ).toEqual({ x: 18, y: 38, width: 604, height: 404, radius: 0 })
  })

  it("grows a positive radius by the inflate amount, but leaves a zero radius alone", () => {
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100, radius: "8px" }, 1, 1),
    ).toEqual({ x: -1, y: -1, width: 102, height: 102, radius: 9 })
    expect(
      cssRectToPhysicalBounds({ x: 0, y: 0, width: 100, height: 100 }, 1, 1),
    ).toEqual({ x: -1, y: -1, width: 102, height: 102, radius: 0 })
  })

  it("defaults to no inflation when the parameter is omitted", () => {
    expect(cssRectToPhysicalBounds({ x: 10, y: 20, width: 300, height: 200 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      radius: 0,
    })
  })
})

describe("boundsEqual", () => {
  const bounds = { x: 1, y: 2, width: 300, height: 200, radius: 8 }

  it("is true for two structurally identical bounds", () => {
    expect(boundsEqual(bounds, { ...bounds })).toBe(true)
  })

  it("is true for the same reference, including two nulls", () => {
    expect(boundsEqual(bounds, bounds)).toBe(true)
    expect(boundsEqual(null, null)).toBe(true)
  })

  it("is false when any single field differs", () => {
    expect(boundsEqual(bounds, { ...bounds, x: 2 })).toBe(false)
    expect(boundsEqual(bounds, { ...bounds, y: 3 })).toBe(false)
    expect(boundsEqual(bounds, { ...bounds, width: 301 })).toBe(false)
    expect(boundsEqual(bounds, { ...bounds, height: 201 })).toBe(false)
    expect(boundsEqual(bounds, { ...bounds, radius: 9 })).toBe(false)
  })

  it("is false when only one side is null", () => {
    expect(boundsEqual(bounds, null)).toBe(false)
    expect(boundsEqual(null, bounds)).toBe(false)
  })
})

describe("cssRectToNativeVideoHoleVars", () => {
  it("maps a CSS rect to px custom properties with a zero radius when omitted", () => {
    expect(cssRectToNativeVideoHoleVars({ x: 10, y: 20, width: 300, height: 200 })).toEqual({
      "--xt-video-x": "10px",
      "--xt-video-y": "20px",
      "--xt-video-w": "300px",
      "--xt-video-h": "200px",
      "--xt-video-r": "0px",
    })
  })

  it("preserves fractional values and reads a CSS pixel radius", () => {
    expect(
      cssRectToNativeVideoHoleVars({ x: 10.5, y: 20.25, width: 300.75, height: 200.1, radius: "12px" }),
    ).toEqual({
      "--xt-video-x": "10.5px",
      "--xt-video-y": "20.25px",
      "--xt-video-w": "300.75px",
      "--xt-video-h": "200.1px",
      "--xt-video-r": "12px",
    })
  })
})

describe("buildLoadOptions", () => {
  it("defaults isLive to true and every other field to null when nothing is supplied", () => {
    expect(buildLoadOptions({})).toEqual({
      userAgent: null,
      referer: null,
      startSeconds: null,
      isLive: true,
      networkTimeoutSeconds: null,
      mediaTitle: null,
    })
  })

  it("carries userAgent/referer through untouched", () => {
    expect(
      buildLoadOptions({ userAgent: "xtream/1.0", referer: "https://example.com" }),
    ).toEqual({
      userAgent: "xtream/1.0",
      referer: "https://example.com",
      startSeconds: null,
      isLive: true,
      networkTimeoutSeconds: null,
      mediaTitle: null,
    })
  })

  it("trims mediaTitle and defaults an empty or missing one to null", () => {
    expect(buildLoadOptions({ mediaTitle: "  BBC One  " }).mediaTitle).toBe("BBC One")
    expect(buildLoadOptions({ mediaTitle: "   " }).mediaTitle).toBe(null)
    expect(buildLoadOptions({ mediaTitle: null }).mediaTitle).toBe(null)
  })

  it("carries a positive networkTimeoutSeconds through", () => {
    expect(buildLoadOptions({ networkTimeoutSeconds: 45 }).networkTimeoutSeconds).toBe(45)
  })

  it("ignores a zero, negative, or non-finite networkTimeoutSeconds", () => {
    expect(buildLoadOptions({ networkTimeoutSeconds: 0 }).networkTimeoutSeconds).toBe(null)
    expect(buildLoadOptions({ networkTimeoutSeconds: -5 }).networkTimeoutSeconds).toBe(null)
    expect(buildLoadOptions({ networkTimeoutSeconds: null }).networkTimeoutSeconds).toBe(null)
  })

  it("only sets isLive to false when explicitly false", () => {
    expect(buildLoadOptions({ isLive: false }).isLive).toBe(false)
    expect(buildLoadOptions({ isLive: true }).isLive).toBe(true)
    expect(buildLoadOptions({ isLive: undefined }).isLive).toBe(true)
  })

  it("uses timelineOffsetSeconds as the start position even below the resume threshold", () => {
    expect(buildLoadOptions({ timelineOffsetSeconds: 2 }).startSeconds).toBe(2)
  })

  it("ignores a zero or negative timelineOffsetSeconds and falls back to resumeSeconds", () => {
    expect(buildLoadOptions({ timelineOffsetSeconds: 0, resumeSeconds: 30 }).startSeconds).toBe(30)
    expect(buildLoadOptions({ timelineOffsetSeconds: -5, resumeSeconds: 30 }).startSeconds).toBe(30)
  })

  it("ignores resumeSeconds at or below the resume threshold", () => {
    expect(buildLoadOptions({ resumeSeconds: 5 }).startSeconds).toBe(null)
    expect(buildLoadOptions({ resumeSeconds: 3 }).startSeconds).toBe(null)
  })

  it("uses resumeSeconds above the resume threshold", () => {
    expect(buildLoadOptions({ resumeSeconds: 6 }).startSeconds).toBe(6)
  })

  it("prefers timelineOffsetSeconds over resumeSeconds when both are given", () => {
    expect(buildLoadOptions({ timelineOffsetSeconds: 120, resumeSeconds: 600 }).startSeconds).toBe(120)
  })
})

describe("deriveEvents", () => {
  it("returns no events for an unchanged empty state", () => {
    expect(deriveEvents(null, {})).toEqual([])
  })

  it("fires playing on the first state transition when core-idle is already false and unpaused", () => {
    expect(deriveEvents(null, { coreIdle: false, pause: false })).toEqual(["playing"])
  })

  it("does not fire playing when core-idle goes false but playback is paused", () => {
    expect(deriveEvents({ coreIdle: true }, { coreIdle: false, pause: true })).toEqual(["pause"])
  })

  it("fires waiting when pausedForCache transitions to true", () => {
    expect(deriveEvents({ pausedForCache: false }, { pausedForCache: true })).toEqual(["waiting"])
  })

  it("fires waiting and seeking when seeking transitions from undefined to true", () => {
    expect(deriveEvents({}, { seeking: true })).toEqual(["waiting", "seeking"])
  })

  it("fires seeked when seeking transitions back to false", () => {
    expect(deriveEvents({ seeking: true }, { seeking: false })).toEqual(["seeked"])
  })

  it("does not fire seeking/seeked when the seeking state is unchanged", () => {
    expect(deriveEvents({ seeking: true }, { seeking: true })).toEqual([])
    expect(deriveEvents({ seeking: false }, { seeking: false })).toEqual([])
  })

  it("fires play when pause transitions from true to false", () => {
    expect(deriveEvents({ pause: true }, { pause: false })).toEqual(["play"])
  })

  it("does not fire play on the first-ever unpaused state (no prior pause: true)", () => {
    expect(deriveEvents({}, { pause: false })).toEqual([])
  })

  it("fires volumechange when volume or mute changes", () => {
    expect(deriveEvents({ volume: 50 }, { volume: 80 })).toEqual(["volumechange"])
    expect(deriveEvents({ mute: false }, { mute: true })).toEqual(["volumechange"])
  })

  it("does not fire volumechange when volume/mute are unchanged", () => {
    expect(deriveEvents({ volume: 50, mute: false }, { volume: 50, mute: false })).toEqual([])
  })

  it("fires durationchange when duration changes", () => {
    expect(deriveEvents({ duration: 60 }, { duration: 90 })).toEqual(["durationchange"])
  })

  it("fires ratechange when speed changes", () => {
    expect(deriveEvents({ speed: 1 }, { speed: 1.5 })).toEqual(["ratechange"])
  })

  it("does not repeat waiting when pausedForCache stays true across updates", () => {
    const holdingCache = { pausedForCache: true }
    expect(deriveEvents(holdingCache, { pausedForCache: true, timePos: 12 })).toEqual(["timeupdate"])
  })

  it("fires timeupdate only when timePos actually changes", () => {
    expect(deriveEvents({ timePos: 10 }, { timePos: 10.5 })).toEqual(["timeupdate"])
    expect(deriveEvents({ timePos: 10 }, { timePos: 10 })).toEqual([])
  })

  it("fires pause when pause transitions to true", () => {
    expect(deriveEvents({ pause: false }, { pause: true })).toEqual(["pause"])
  })

  it("does not re-fire pause when already paused", () => {
    expect(deriveEvents({ pause: true }, { pause: true })).toEqual([])
  })

  it("can fire multiple events for one merged update, in a stable order", () => {
    expect(
      deriveEvents({ seeking: false, timePos: 5 }, { seeking: true, timePos: 6 }),
    ).toEqual(["waiting", "seeking", "timeupdate"])
  })

  it("fires playing and play, but no pause event, on resume from a caller-driven unpause", () => {
    expect(
      deriveEvents({ coreIdle: true, pause: true }, { coreIdle: false, pause: false }),
    ).toEqual(["playing", "play"])
  })

  it("fires recordingchange when streamRecord changes", () => {
    expect(deriveEvents({ streamRecord: "" }, { streamRecord: "C:\\recordings\\live.ts" })).toEqual([
      "recordingchange",
    ])
    expect(deriveEvents({ streamRecord: "C:\\recordings\\live.ts" }, { streamRecord: "" })).toEqual([
      "recordingchange",
    ])
  })

  it("does not fire recordingchange when streamRecord is unchanged", () => {
    expect(deriveEvents({ streamRecord: "" }, { streamRecord: "" })).toEqual([])
  })

  it("fires cachechange when the cache range moves while timePos is frozen (paused live)", () => {
    expect(deriveEvents({ timePos: 10, cacheRangeEnd: 30 }, { timePos: 10, cacheRangeEnd: 32 })).toEqual([
      "cachechange",
    ])
    expect(deriveEvents({ timePos: 10, cacheRangeStart: 0 }, { timePos: 10, cacheRangeStart: 2 })).toEqual([
      "cachechange",
    ])
  })

  it("does not fire cachechange when the cache range is unchanged", () => {
    expect(deriveEvents({ cacheRangeStart: 0, cacheRangeEnd: 30 }, { cacheRangeStart: 0, cacheRangeEnd: 30 })).toEqual(
      [],
    )
  })
})

describe("liveEofReloadDelayMs", () => {
  it("backs off 1s, 2s, 4s, 8s, then 15s across the five allowed attempts", () => {
    expect(liveEofReloadDelayMs(1)).toBe(1000)
    expect(liveEofReloadDelayMs(2)).toBe(2000)
    expect(liveEofReloadDelayMs(3)).toBe(4000)
    expect(liveEofReloadDelayMs(4)).toBe(8000)
    expect(liveEofReloadDelayMs(5)).toBe(15000)
  })

  it("returns null once the retry budget is exhausted", () => {
    expect(liveEofReloadDelayMs(6)).toBe(null)
    expect(liveEofReloadDelayMs(10)).toBe(null)
  })

  it("returns null for a non-positive attempt", () => {
    expect(liveEofReloadDelayMs(0)).toBe(null)
    expect(liveEofReloadDelayMs(-1)).toBe(null)
  })
})

describe("isWithinOfflinePlaceholderWindow", () => {
  it("is true for a live source that hit EOF just after playback restarted", () => {
    expect(isWithinOfflinePlaceholderWindow(true, 0)).toBe(true)
    expect(isWithinOfflinePlaceholderWindow(true, OFFLINE_PLACEHOLDER_WINDOW_MS - 1)).toBe(true)
  })

  it("is false once the window has elapsed", () => {
    expect(isWithinOfflinePlaceholderWindow(true, OFFLINE_PLACEHOLDER_WINDOW_MS)).toBe(false)
    expect(isWithinOfflinePlaceholderWindow(true, OFFLINE_PLACEHOLDER_WINDOW_MS + 5000)).toBe(false)
  })

  it("is false for a non-live source regardless of elapsed time", () => {
    expect(isWithinOfflinePlaceholderWindow(false, 0)).toBe(false)
  })

  it("is false when no playback-restart has been observed yet", () => {
    expect(isWithinOfflinePlaceholderWindow(true, null)).toBe(false)
  })
})

describe("classifyMpvNetworkError", () => {
  it("passes through a null detail", () => {
    expect(classifyMpvNetworkError(null)).toBe(null)
  })

  it("prefixes NETWORK: for connectivity-looking error text", () => {
    expect(classifyMpvNetworkError("Connection timed out")).toBe("NETWORK:Connection timed out")
    expect(classifyMpvNetworkError("connection refused")).toBe("NETWORK:connection refused")
    expect(classifyMpvNetworkError("Failed to resolve hostname")).toBe("NETWORK:Failed to resolve hostname")
    expect(classifyMpvNetworkError("HTTP error 404")).toBe("NETWORK:HTTP error 404")
  })

  it("leaves unrelated error text untouched", () => {
    expect(classifyMpvNetworkError("Unsupported codec")).toBe("Unsupported codec")
  })
})

describe("parseHttpStatusPrefix", () => {
  it("reads the status code off a HTTP_STATUS: prefixed detail", () => {
    expect(parseHttpStatusPrefix("HTTP_STATUS:403:server refused connection")).toBe(403)
  })

  it("returns null for a non-prefixed or null detail", () => {
    expect(parseHttpStatusPrefix("connection refused")).toBe(null)
    expect(parseHttpStatusPrefix(null)).toBe(null)
  })
})

describe("classifyMpvEndFileError", () => {
  it("prefixes HTTP_STATUS: when a 4xx/5xx status is given", () => {
    expect(classifyMpvEndFileError("server refused connection", 403)).toBe(
      "HTTP_STATUS:403:server refused connection",
    )
  })

  it("falls back to NETWORK: classification when there is no status", () => {
    expect(classifyMpvEndFileError("connection timed out", null)).toBe("NETWORK:connection timed out")
  })

  it("round-trips through parseHttpStatusPrefix", () => {
    const classified = classifyMpvEndFileError("forbidden", 403)
    expect(parseHttpStatusPrefix(classified)).toBe(403)
  })
})

describe("shouldIgnoreEofAfterLiveSeek", () => {
  it("is false when no live seek has happened", () => {
    expect(shouldIgnoreEofAfterLiveSeek(true, null, LIVE_SEEK_EOF_GRACE_MS)).toBe(false)
  })

  it("is true within the grace window after a live seek", () => {
    expect(shouldIgnoreEofAfterLiveSeek(true, 0, LIVE_SEEK_EOF_GRACE_MS)).toBe(true)
    expect(shouldIgnoreEofAfterLiveSeek(true, LIVE_SEEK_EOF_GRACE_MS - 1, LIVE_SEEK_EOF_GRACE_MS)).toBe(true)
  })

  it("is false once the grace window has elapsed", () => {
    expect(shouldIgnoreEofAfterLiveSeek(true, LIVE_SEEK_EOF_GRACE_MS, LIVE_SEEK_EOF_GRACE_MS)).toBe(false)
  })

  it("is false for a non-live source regardless of elapsed time", () => {
    expect(shouldIgnoreEofAfterLiveSeek(false, 0, LIVE_SEEK_EOF_GRACE_MS)).toBe(false)
  })
})

describe("shouldReloadForStall", () => {
  const baseInput = {
    isLive: true,
    paused: false,
    hasPlaybackRestarted: true,
    reloadInFlight: false,
    msSinceProgress: LIVE_STALL_THRESHOLD_MS,
    thresholdMs: LIVE_STALL_THRESHOLD_MS,
  }

  it("is true once the stall threshold is reached on a playing live source", () => {
    expect(shouldReloadForStall(baseInput)).toBe(true)
  })

  it("is false below the threshold", () => {
    expect(shouldReloadForStall({ ...baseInput, msSinceProgress: LIVE_STALL_THRESHOLD_MS - 1 })).toBe(false)
  })

  it("is false for a non-live source, paused, not-yet-restarted, or an in-flight reload", () => {
    expect(shouldReloadForStall({ ...baseInput, isLive: false })).toBe(false)
    expect(shouldReloadForStall({ ...baseInput, paused: true })).toBe(false)
    expect(shouldReloadForStall({ ...baseInput, hasPlaybackRestarted: false })).toBe(false)
    expect(shouldReloadForStall({ ...baseInput, reloadInFlight: true })).toBe(false)
  })
})

describe("subtitleStyleToMpvProperties", () => {
  it("maps the default style", () => {
    expect(subtitleStyleToMpvProperties(DEFAULT_MPV_SUBTITLE_STYLE)).toEqual({
      "sub-scale": 1,
      "sub-pos": 100,
      "sub-color": "#FFFFFF",
    })
  })

  it("maps every size/position/color combination", () => {
    expect(subtitleStyleToMpvProperties({ size: "small", position: "raised", color: "yellow" })).toEqual({
      "sub-scale": 0.8,
      "sub-pos": 80,
      "sub-color": "#FFFF00",
    })
    expect(subtitleStyleToMpvProperties({ size: "xlarge", position: "bottom", color: "white" })).toEqual({
      "sub-scale": 1.5,
      "sub-pos": 100,
      "sub-color": "#FFFFFF",
    })
  })
})

describe("parseSubtitleStyle", () => {
  it("defaults on a null or empty value", () => {
    expect(parseSubtitleStyle(null)).toEqual(DEFAULT_MPV_SUBTITLE_STYLE)
    expect(parseSubtitleStyle("")).toEqual(DEFAULT_MPV_SUBTITLE_STYLE)
  })

  it("defaults on invalid JSON or an unrecognized field value", () => {
    expect(parseSubtitleStyle("not json")).toEqual(DEFAULT_MPV_SUBTITLE_STYLE)
    expect(parseSubtitleStyle(JSON.stringify({ size: "huge", position: "bottom", color: "white" }))).toEqual(
      DEFAULT_MPV_SUBTITLE_STYLE,
    )
  })

  it("round-trips a valid persisted style", () => {
    const style = { size: "large", position: "raised", color: "yellow" } as const
    expect(parseSubtitleStyle(JSON.stringify(style))).toEqual(style)
  })
})

describe("clampAudioDelaySeconds", () => {
  it("rounds to the nearest 0.05s", () => {
    expect(clampAudioDelaySeconds(0.12)).toBe(0.1)
    expect(clampAudioDelaySeconds(0.13)).toBe(0.15)
  })

  it("clamps to +-5s", () => {
    expect(clampAudioDelaySeconds(10)).toBe(5)
    expect(clampAudioDelaySeconds(-10)).toBe(-5)
  })

  it("falls back to 0 for a non-finite value", () => {
    expect(clampAudioDelaySeconds(NaN)).toBe(0)
  })
})

describe("recordingFileName", () => {
  const date = new Date(2026, 8, 4, 13, 5, 9)

  it("sanitizes a title and appends a timestamp", () => {
    expect(recordingFileName("BBC One: HD?", date)).toBe("BBC-One-HD-20260904-130509.ts")
  })

  it("falls back to \"recording\" for a null or empty title", () => {
    expect(recordingFileName(null, date)).toBe("recording-20260904-130509.ts")
    expect(recordingFileName("   ", date)).toBe("recording-20260904-130509.ts")
  })

  it("caps the sanitized title at 80 characters", () => {
    const longTitle = "a".repeat(200)
    const result = recordingFileName(longTitle, date)
    expect(result).toBe(`${"a".repeat(80)}-20260904-130509.ts`)
  })
})

describe("clampPlaybackRate", () => {
  it("passes through a rate already within range", () => {
    expect(clampPlaybackRate(1)).toBe(1)
    expect(clampPlaybackRate(2)).toBe(2)
  })

  it("clamps below 0.25 up to 0.25", () => {
    expect(clampPlaybackRate(0)).toBe(0.25)
    expect(clampPlaybackRate(-1)).toBe(0.25)
  })

  it("clamps above 4 down to 4", () => {
    expect(clampPlaybackRate(10)).toBe(4)
  })

  it("falls back to 1 for a non-finite rate", () => {
    expect(clampPlaybackRate(NaN)).toBe(1)
    expect(clampPlaybackRate(Infinity)).toBe(1)
  })
})

describe("sumDroppedFrames", () => {
  it("sums both counters when present", () => {
    expect(sumDroppedFrames(3, 2)).toBe(5)
  })

  it("treats a missing counter as 0", () => {
    expect(sumDroppedFrames(3, undefined)).toBe(3)
    expect(sumDroppedFrames(undefined, 2)).toBe(2)
  })

  it("returns null when neither counter is present", () => {
    expect(sumDroppedFrames(undefined, undefined)).toBe(null)
  })
})
