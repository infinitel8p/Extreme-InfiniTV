/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

// The module reads `window.AndroidVideo` at import time for the
// `androidNativePlayerAvailable` constant, and at call time inside
// launchAndroidNativeVod / launchAndroidNativeLive. So we mutate
// `window.AndroidVideo` between tests.
beforeEach(() => {
  vi.resetModules()
  ;(window as unknown as { AndroidVideo?: unknown }).AndroidVideo = undefined
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => "Mozilla/5.0 (Linux; Android 13; Pixel 7)",
  })
})

afterEach(() => {
  ;(window as unknown as { AndroidVideo?: unknown }).AndroidVideo = undefined
})

describe("launchAndroidNativeVod", () => {
  it("returns false when the bridge is missing", async () => {
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    expect(
      mod.launchAndroidNativeVod({ contentKey: "vod:1", url: "https://x/a.m3u8" }),
    ).toBe(false)
  })

  it("forwards every parameter to the bridge in order", async () => {
    type LaunchVodFn = (
      contentKey: string,
      url: string,
      ua: string,
      referer: string,
      title: string,
      posterUrl: string,
      startMs: number,
      dns: string,
      audioLang: string | null,
      subLang: string | null,
      subEnabled: boolean,
    ) => boolean
    const launchVod = vi.fn<LaunchVodFn>(() => true)
    ;(window as any).AndroidVideo = {
      launchVod,
      launchLive: vi.fn(),
      drainEvents: vi.fn(() => "[]"),
    }
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    const ok = mod.launchAndroidNativeVod({
      contentKey: "vod:42",
      url: "https://x/a.m3u8",
      ua: "TestUA",
      referer: "https://ref",
      title: "A Movie",
      posterUrl: "https://poster",
      startMs: 12345,
      dns: "1.1.1.1",
      tracks: { audioLang: "de", subLang: "en", subOff: false },
    })
    expect(ok).toBe(true)
    expect(launchVod).toHaveBeenCalledWith(
      "vod:42",
      "https://x/a.m3u8",
      "TestUA",
      "https://ref",
      "A Movie",
      "https://poster",
      12345,
      "1.1.1.1",
      "de",
      "en",
      true,
    )
  })

  it("defaults the track args to null/null/false when tracks is absent", async () => {
    const launchVod = vi.fn<(...args: unknown[]) => boolean>(() => true)
    ;(window as any).AndroidVideo = { launchVod }
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    mod.launchAndroidNativeVod({ contentKey: "k", url: "u" })
    expect(launchVod.mock.calls[0]?.[8]).toBeNull()
    expect(launchVod.mock.calls[0]?.[9]).toBeNull()
    expect(launchVod.mock.calls[0]?.[10]).toBe(false)
  })

  it("forwards an empty dns string when none is provided", async () => {
    const launchVod = vi.fn<(...args: unknown[]) => boolean>(() => true)
    ;(window as any).AndroidVideo = { launchVod }
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    mod.launchAndroidNativeVod({ contentKey: "k", url: "u" })
    expect(launchVod.mock.calls[0]?.[7]).toBe("")
  })

  it("clamps a negative startMs to 0", async () => {
    type LaunchVodFn = (
      contentKey: string,
      url: string,
      ua: string,
      referer: string,
      title: string,
      posterUrl: string,
      startMs: number,
      dns: string,
    ) => boolean
    const launchVod = vi.fn<LaunchVodFn>(() => true)
    ;(window as any).AndroidVideo = { launchVod }
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    mod.launchAndroidNativeVod({ contentKey: "k", url: "u", startMs: -50 })
    expect(launchVod.mock.calls[0]?.[6]).toBe(0)
  })

  it("returns false if the bridge throws", async () => {
    ;(window as any).AndroidVideo = {
      launchVod: () => { throw new Error("native failure") },
    }
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    expect(
      mod.launchAndroidNativeVod({ contentKey: "k", url: "u" }),
    ).toBe(false)
  })
})

describe("launchAndroidNativeLive", () => {
  it("serializes the channel list to JSON before passing it across", async () => {
    type LaunchLiveFn = (
      contentKey: string,
      channelsJson: string,
      initialChannelId: string,
      ua: string,
      referer: string,
      dns: string,
    ) => boolean
    const launchLive = vi.fn<LaunchLiveFn>(() => true)
    ;(window as any).AndroidVideo = { launchLive, launchVod: vi.fn() }
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    mod.launchAndroidNativeLive({
      contentKey: "live:1",
      channels: [
        { id: 1, name: "A", streamUrl: "https://x/a.m3u8" },
        { id: 2, name: "B", streamUrl: "https://x/b.m3u8" },
      ],
      initialChannelId: "1",
    })
    expect(launchLive).toHaveBeenCalled()
    const json = launchLive.mock.calls[0]?.[1] || "[]"
    const parsed = JSON.parse(json)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].name).toBe("A")
  })

  it("forwards a dns override to the bridge", async () => {
    const launchLive = vi.fn<(...args: unknown[]) => boolean>(() => true)
    ;(window as any).AndroidVideo = { launchLive, launchVod: vi.fn() }
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    mod.launchAndroidNativeLive({
      contentKey: "live:1",
      channels: [{ id: 1, name: "A", streamUrl: "https://x/a.m3u8" }],
      initialChannelId: "1",
      dns: "1.1.1.1:5353",
    })
    expect(launchLive.mock.calls[0]?.[5]).toBe("1.1.1.1:5353")
  })
})

describe("subscribeAndroidNativeEvents", () => {
  it("routes DOM CustomEvents to subscribers", async () => {
    ;(window as any).AndroidVideo = {
      launchVod: vi.fn(),
      drainEvents: () => "[]",
    }
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    const calls: any[] = []
    const unsubscribe = mod.subscribeAndroidNativeEvents((e) => calls.push(e))

    document.dispatchEvent(
      new CustomEvent("xt:android-native-progress", {
        detail: { contentKey: "vod:1", positionMs: 30000, durationMs: 120000 },
      }),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].type).toBe("xt:android-native-progress")
    expect(calls[0].payload.contentKey).toBe("vod:1")
    expect(calls[0].payload.positionMs).toBe(30000)

    unsubscribe()
    document.dispatchEvent(
      new CustomEvent("xt:android-native-progress", {
        detail: { contentKey: "vod:1", positionMs: 60000 },
      }),
    )
    expect(calls).toHaveLength(1)
  })

  it("returns a no-op unsubscribe when window is missing AndroidVideo", async () => {
    ;(window as any).AndroidVideo = undefined
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    const unsubscribe = mod.subscribeAndroidNativeEvents(() => {})
    expect(() => unsubscribe()).not.toThrow()
  })
})

describe("tracksLaunchOptionsFor / persistNativeTracksEvent", () => {
  const localStorageStore = new Map<string, string>()
  const localStorageMock: Storage = {
    getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key)! : null),
    setItem: (key, value) => {
      localStorageStore.set(key, String(value))
    },
    removeItem: (key) => {
      localStorageStore.delete(key)
    },
    clear: () => {
      localStorageStore.clear()
    },
    key: (index) => Array.from(localStorageStore.keys())[index] ?? null,
    get length() {
      return localStorageStore.size
    },
  }

  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageMock)
    localStorageStore.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns null for a null context", async () => {
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    expect(mod.tracksLaunchOptionsFor(null)).toBeNull()
  })

  it("returns null when no prefs are stored for the context", async () => {
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    expect(mod.tracksLaunchOptionsFor({ playlistId: "p1", kind: "vod", id: "9" })).toBeNull()
  })

  it("reads stored prefs into the launch-options shape", async () => {
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    const prefs = await import("@/scripts/lib/preferences.js")
    prefs.setTrackPrefs("p1", "vod", "9", { audioLang: "de", subLang: "en", subOff: true })
    expect(mod.tracksLaunchOptionsFor({ playlistId: "p1", kind: "vod", id: "9" })).toEqual({
      audioLang: "de",
      subLang: "en",
      subOff: true,
    })
  })

  it("persists a native-tracks payload with normalized languages", async () => {
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    const prefs = await import("@/scripts/lib/preferences.js")
    mod.persistNativeTracksEvent(
      { playlistId: "p1", kind: "episode", id: "5" },
      { audioLang: "eng", audioLabel: "English", subLang: "ger", subLabel: "German", subOff: false },
    )
    expect(prefs.getTrackPrefs("p1", "episode", "5")).toMatchObject({
      audioLang: "en",
      audioTitle: "English",
      subLang: "de",
      subTitle: "German",
      subOff: false,
    })
  })

  it("is a no-op for a null context", async () => {
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    expect(() => mod.persistNativeTracksEvent(null, { audioLang: "en" })).not.toThrow()
  })
})

describe("launchAndroidNativeVodWithProgress track prefs", () => {
  // preferences.js falls back to localStorage outside Tauri; Node 24's native
  // localStorage shadows jsdom's, so stub a real in-memory Storage.
  const localStorageStore = new Map<string, string>()
  const localStorageMock: Storage = {
    getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key)! : null),
    setItem: (key, value) => {
      localStorageStore.set(key, String(value))
    },
    removeItem: (key) => {
      localStorageStore.delete(key)
    },
    clear: () => {
      localStorageStore.clear()
    },
    key: (index) => Array.from(localStorageStore.keys())[index] ?? null,
    get length() {
      return localStorageStore.size
    },
  }

  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageMock)
    localStorageStore.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("passes stored track prefs from getTrackPrefs to the launch call", async () => {
    const launchVod = vi.fn<(...args: unknown[]) => boolean>(() => true)
    ;(window as any).AndroidVideo = { launchVod, drainEvents: () => "[]" }
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    const prefs = await import("@/scripts/lib/preferences.js")
    prefs.setTrackPrefs("playlist-1", "vod", 7, { audioLang: "de", subLang: "en", subOff: false })

    mod.launchAndroidNativeVodWithProgress({
      playlistId: "playlist-1",
      contentKey: "vod:7",
      kind: "vod",
      id: 7,
      url: "https://x/a.mp4",
    })

    expect(launchVod.mock.calls[0]?.[8]).toBe("de")
    expect(launchVod.mock.calls[0]?.[9]).toBe("en")
    expect(launchVod.mock.calls[0]?.[10]).toBe(true)
  })

  it("writes an xt:android-native-tracks event into setTrackPrefs with normalized languages", async () => {
    const launchVod = vi.fn<(...args: unknown[]) => boolean>(() => true)
    ;(window as any).AndroidVideo = { launchVod, drainEvents: () => "[]" }
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    const prefs = await import("@/scripts/lib/preferences.js")

    mod.launchAndroidNativeVodWithProgress({
      playlistId: "playlist-1",
      contentKey: "vod:7",
      kind: "vod",
      id: 7,
      url: "https://x/a.mp4",
    })

    document.dispatchEvent(
      new CustomEvent("xt:android-native-tracks", {
        detail: {
          contentKey: "vod:7",
          audioLang: "eng",
          audioLabel: "English",
          subLang: "ger",
          subLabel: "German",
          subOff: false,
        },
      }),
    )

    expect(prefs.getTrackPrefs("playlist-1", "vod", 7)).toMatchObject({
      audioLang: "en",
      audioTitle: "English",
      subLang: "de",
      subTitle: "German",
      subOff: false,
    })
  })

  it("ignores an xt:android-native-tracks event for a different contentKey", async () => {
    const launchVod = vi.fn<(...args: unknown[]) => boolean>(() => true)
    ;(window as any).AndroidVideo = { launchVod, drainEvents: () => "[]" }
    const mod = await import("@/scripts/lib/android-video-launcher.js")
    const prefs = await import("@/scripts/lib/preferences.js")

    mod.launchAndroidNativeVodWithProgress({
      playlistId: "playlist-1",
      contentKey: "vod:7",
      kind: "vod",
      id: 7,
      url: "https://x/a.mp4",
    })

    document.dispatchEvent(
      new CustomEvent("xt:android-native-tracks", {
        detail: { contentKey: "vod:other", audioLang: "en", subOff: true },
      }),
    )

    expect(prefs.getTrackPrefs("playlist-1", "vod", 7)).toBeNull()
  })
})
