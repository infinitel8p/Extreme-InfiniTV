import { describe, it, expect } from "vitest"
import {
  buildMpvArgs,
  buildVlcArgs,
  buildArgsFor,
  classifyError,
  PlayerLaunchError,
  externalPlayersAvailable,
  androidMimeForUrl,
  mpegtsRelativeTimestampOffset,
  defineRelativeTimestampOffset,
  manifestKindFromExtension,
  shouldPreferNativeHls,
} from "../src/scripts/lib/player-runtime"

const SRC = "https://example.com/live/u/p/1.m3u8"

describe("manifestKindFromExtension", () => {
  // Probing costs a provider connection slot (Xtream counts /live GETs against
  // max_connections), so any URL whose extension is conclusive must skip it.
  it("resolves HLS manifests without a network probe", () => {
    expect(manifestKindFromExtension("http://host/live/u/p/123.m3u8")).toBe("hls")
    expect(manifestKindFromExtension("http://host/live/u/p/123.m3u")).toBe("hls")
    expect(manifestKindFromExtension("http://host/LIVE/U/P/123.M3U8")).toBe("hls")
  })

  it("resolves DASH manifests without a network probe", () => {
    expect(manifestKindFromExtension("https://host/path/stream.mpd")).toBe("dash")
  })

  it("ignores the query string when reading the extension", () => {
    expect(manifestKindFromExtension("http://host/live/u/p/9.m3u8?token=abc&x=1")).toBe("hls")
  })

  it("still probes .ts, because some panels serve HLS from a .ts path", () => {
    expect(manifestKindFromExtension("http://host/live/u/p/123.ts")).toBeNull()
  })

  it("still probes extensionless and progressive URLs", () => {
    expect(manifestKindFromExtension("http://host/live/play/token/123")).toBeNull()
    expect(manifestKindFromExtension("http://host/movie/u/p/5.mkv")).toBeNull()
    expect(manifestKindFromExtension("http://host/movie/u/p/5.mp4")).toBeNull()
  })

  it("returns null for a malformed URL rather than guessing", () => {
    expect(manifestKindFromExtension("not a url")).toBeNull()
    expect(manifestKindFromExtension("")).toBeNull()
  })
})

describe("mpegtsRelativeTimestampOffset", () => {
  it("rebases the native absolute offset before mpegts compares segment offsets", () => {
    expect(mpegtsRelativeTimestampOffset(60.02, 60)).toBeCloseTo(0.02)
    expect(mpegtsRelativeTimestampOffset(60, 60)).toBe(0)
  })
})

describe("defineRelativeTimestampOffset", () => {
  it("round-trips a relative value through a real timestampOffset property", () => {
    const sourceBuffer = { timestampOffset: 0 }
    defineRelativeTimestampOffset(sourceBuffer, 60)
    expect(sourceBuffer.timestampOffset).toBe(0)
    sourceBuffer.timestampOffset = 0.02
    expect(sourceBuffer.timestampOffset).toBeCloseTo(0.02)
  })

  it("reads and writes through a native accessor-based timestampOffset", () => {
    let nativeValue = 0
    const sourceBuffer = {} as { timestampOffset: number }
    Object.defineProperty(sourceBuffer, "timestampOffset", {
      configurable: true,
      get() {
        return nativeValue
      },
      set(value: number) {
        nativeValue = value
      },
    })

    defineRelativeTimestampOffset(sourceBuffer, 60)
    expect(nativeValue).toBe(60)
    expect(sourceBuffer.timestampOffset).toBe(0)

    sourceBuffer.timestampOffset = 0.02
    expect(nativeValue).toBeCloseTo(60.02)
    expect(sourceBuffer.timestampOffset).toBeCloseTo(0.02)

    nativeValue = 60.5
    expect(sourceBuffer.timestampOffset).toBeCloseTo(0.5)
  })
})

describe("buildMpvArgs", () => {
  it("emits required flags and src last with no optional inputs", () => {
    const args = buildMpvArgs({ src: SRC })
    expect(args).toEqual([
      "--force-window=immediate",
      "--no-terminal",
      SRC,
    ])
  })

  it("passes user-agent and referrer when supplied", () => {
    const args = buildMpvArgs({
      src: SRC,
      userAgent: "Mozilla/5.0 Test",
      referer: "https://example.com/",
    })
    expect(args).toContain("--user-agent=Mozilla/5.0 Test")
    expect(args).toContain("--referrer=https://example.com/")
    expect(args.at(-1)).toBe(SRC)
  })

  it("passes --start when resumeSeconds exceeds the threshold", () => {
    const args = buildMpvArgs({ src: SRC, resumeSeconds: 90 })
    expect(args).toContain("--start=90")
  })

  it("omits --start when resumeSeconds is below the threshold", () => {
    const args = buildMpvArgs({ src: SRC, resumeSeconds: 3 })
    expect(args.some((arg) => arg.startsWith("--start="))).toBe(false)
  })

  it("omits --start when resumeSeconds is missing or zero", () => {
    expect(buildMpvArgs({ src: SRC }).some((a) => a.startsWith("--start="))).toBe(false)
    expect(
      buildMpvArgs({ src: SRC, resumeSeconds: 0 }).some((a) => a.startsWith("--start=")),
    ).toBe(false)
  })

  it("respects a custom resumeMinSeconds", () => {
    const args = buildMpvArgs({ src: SRC, resumeSeconds: 3, resumeMinSeconds: 1 })
    expect(args).toContain("--start=3")
  })

  it("inserts user extra args before src", () => {
    const args = buildMpvArgs({
      src: SRC,
      extraArgs: ["--hwdec=auto", "--cache-secs=20"],
    })
    expect(args.indexOf("--hwdec=auto")).toBeLessThan(args.indexOf(SRC))
    expect(args.indexOf("--cache-secs=20")).toBeLessThan(args.indexOf(SRC))
    expect(args.at(-1)).toBe(SRC)
  })

  it("never leaves null/undefined entries in argv", () => {
    const args = buildMpvArgs({
      src: SRC,
      userAgent: null,
      referer: null,
      resumeSeconds: 0,
      extraArgs: [],
    })
    expect(args.every((a) => typeof a === "string" && a.length > 0)).toBe(true)
  })

  it("filters out empty strings in extraArgs", () => {
    const args = buildMpvArgs({ src: SRC, extraArgs: ["--hwdec=auto", ""] })
    expect(args).toContain("--hwdec=auto")
    expect(args).not.toContain("")
  })

  it("filters out whitespace-only strings in extraArgs", () => {
    const args = buildMpvArgs({ src: SRC, extraArgs: ["--hwdec=auto", "   ", "\t"] })
    expect(args).toContain("--hwdec=auto")
    expect(args).not.toContain("   ")
    expect(args).not.toContain("\t")
  })

  it("forces UDP-first RTSP transport for rtsp:// URLs", () => {
    const args = buildMpvArgs({
      src: "rtsp://192.168.178.1:554/?avm=1&freq=418&msys=dvbc",
    })
    expect(args).toContain("--demuxer-lavf-o=rtsp_transport=udp+tcp")
  })

  it("does not add the RTSP transport flag for http(s) URLs", () => {
    const args = buildMpvArgs({ src: SRC })
    expect(args.some((arg) => arg.includes("rtsp_transport"))).toBe(false)
  })
})

describe("buildVlcArgs", () => {
  it("uses the VLC-flavored option names", () => {
    const args = buildVlcArgs({
      src: SRC,
      userAgent: "Foo",
      referer: "https://r.example/",
      resumeSeconds: 120,
    })
    expect(args).toContain("--http-user-agent=Foo")
    expect(args).toContain("--http-referrer=https://r.example/")
    expect(args).toContain("--start-time=120")
    expect(args.at(-1)).toBe(SRC)
  })

  it("includes core flags by default and skips Qt-only flags on macOS", () => {
    const args = buildVlcArgs({ src: SRC })
    expect(args).toContain("--play-and-exit")
    expect(args).toContain("--no-fullscreen")
    expect(args).not.toContain("--no-video-title-show")

    const isMac = /Mac/i.test(
      (typeof navigator !== "undefined" && (navigator as any).platform) || "",
    ) || /Macintosh|Mac OS X/i.test(
      (typeof navigator !== "undefined" && navigator.userAgent) || "",
    )
    if (isMac) {
      expect(args).not.toContain("--no-qt-error-dialogs")
      expect(args).not.toContain("--no-qt-minimal-view")
    } else {
      expect(args).toContain("--no-qt-error-dialogs")
      expect(args).toContain("--no-qt-minimal-view")
    }
  })

  it("omits --start-time when resume below threshold", () => {
    const args = buildVlcArgs({ src: SRC, resumeSeconds: 2 })
    expect(args.some((a) => a.startsWith("--start-time="))).toBe(false)
  })
})

describe("buildArgsFor", () => {
  it("dispatches by kind", () => {
    const mpv = buildArgsFor("mpv", { src: SRC, userAgent: "X" })
    const vlc = buildArgsFor("vlc", { src: SRC, userAgent: "X" })
    expect(mpv).toContain("--user-agent=X")
    expect(vlc).toContain("--http-user-agent=X")
  })
})

describe("classifyError", () => {
  it("maps NOT_FOUND prefix and preserves kind/path", () => {
    const err = classifyError("NOT_FOUND:no file at /usr/bin/mpv", "mpv", "/usr/bin/mpv")
    expect(err).toBeInstanceOf(PlayerLaunchError)
    expect(err.code).toBe("NOT_FOUND")
    expect(err.kind).toBe("mpv")
    expect(err.path).toBe("/usr/bin/mpv")
    expect(err.message).toBe("NOT_FOUND:no file at /usr/bin/mpv")
  })

  it("maps PERMISSION prefix", () => {
    const err = classifyError("PERMISSION:denied", "vlc", "/opt/vlc/vlc")
    expect(err.code).toBe("PERMISSION")
  })

  it("maps TIMEOUT prefix", () => {
    const err = classifyError("TIMEOUT:exceeded 2000ms", "mpv", "/x")
    expect(err.code).toBe("TIMEOUT")
  })

  it("maps OTHER prefix", () => {
    const err = classifyError("OTHER:join: child panicked", "vlc", "/y")
    expect(err.code).toBe("OTHER")
  })

  it("falls back to OTHER for unrecognised prefixes", () => {
    const err = classifyError("something else broke", "vlc", "/y")
    expect(err.code).toBe("OTHER")
    expect(err.message).toBe("something else broke")
  })

  it("unwraps Error instances by .message", () => {
    const wrapped = new Error("PERMISSION:no exec bit")
    const err = classifyError(wrapped, "mpv", "/z")
    expect(err.code).toBe("PERMISSION")
    expect(err.message).toBe("PERMISSION:no exec bit")
  })

  it("stringifies non-string non-Error rejections under OTHER", () => {
    const err = classifyError({ unexpected: true }, "mpv", "/q")
    expect(err.code).toBe("OTHER")
  })
})

describe("externalPlayersAvailable gate", () => {
  it("is false in the vitest node runtime, so mountPlayer falls back to videojs", () => {
    expect(externalPlayersAvailable).toBe(false)
  })
})

// streamKindHint / isDashSource are module-private (no `export`), so the
// embedded-player MPEG-DASH container sniffing can't be reached from a test
// file without a source change. androidMimeForUrl is the exported hint
// function with its own .mpd/dash+xml case, so DASH coverage below goes
// through that instead.
describe("androidMimeForUrl", () => {
  it("maps a .mpd URL to the DASH manifest MIME", () => {
    expect(androidMimeForUrl("https://provider.tld/dash/stream.mpd")).toBe(
      "application/dash+xml",
    )
    expect(androidMimeForUrl("https://provider.tld/dash/stream.mpd?token=abc")).toBe(
      "application/dash+xml",
    )
  })

  it("still maps a plain .m3u8 URL to HLS, not DASH", () => {
    expect(androidMimeForUrl("https://provider.tld/live/stream.m3u8")).toBe(
      "application/vnd.apple.mpegurl",
    )
  })

  it("assumes HLS for a bare Xtream live path with no extension", () => {
    expect(androidMimeForUrl("https://provider.tld/live/user/pass/1234")).toBe(
      "application/vnd.apple.mpegurl",
    )
  })

  it("falls back to video/* for opaque or missing URLs", () => {
    expect(androidMimeForUrl("https://provider.tld/proxy/ts/stream/uuid-1234")).toBe(
      "video/*",
    )
    expect(androidMimeForUrl(null)).toBe("video/*")
    expect(androidMimeForUrl(undefined)).toBe("video/*")
  })
})

describe("shouldPreferNativeHls", () => {
  // Native AVFoundation cannot reliably latch IDR-less GDR streams; hls.js can.
  // Native stays only for the macOS web build, where CORS blocks hls.js.
  it("uses hls.js in the Tauri app on macOS", () => {
    expect(shouldPreferNativeHls({ isMacOS: true, isTauri: true, canPlayNativeHls: true })).toBe(false)
  })

  it("keeps native HLS for the plain web build in Safari", () => {
    expect(shouldPreferNativeHls({ isMacOS: true, isTauri: false, canPlayNativeHls: true })).toBe(true)
  })

  it("never prefers native off macOS", () => {
    expect(shouldPreferNativeHls({ isMacOS: false, isTauri: false, canPlayNativeHls: true })).toBe(false)
    expect(shouldPreferNativeHls({ isMacOS: false, isTauri: true, canPlayNativeHls: true })).toBe(false)
  })

  it("never prefers native when the element cannot play HLS natively", () => {
    expect(shouldPreferNativeHls({ isMacOS: true, isTauri: false, canPlayNativeHls: false })).toBe(false)
  })
})
