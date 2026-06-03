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
    )
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
