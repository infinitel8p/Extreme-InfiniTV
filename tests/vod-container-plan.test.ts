import { describe, it, expect } from "vitest"

import {
  planVodContainerPlayback,
  planLocalVodContainerPlayback,
  detectVodContainer,
  detectVodContainerFromLocalPath,
  isUpstreamHttpFailure,
} from "../src/scripts/lib/vod-container-plan"

const webkitDesktop = { isTauriDesktop: true, isWindows: false, remuxAvailable: true, forceRemux: false }
const windowsDesktop = { isTauriDesktop: true, isWindows: true, remuxAvailable: true, forceRemux: false }

describe("planVodContainerPlayback", () => {
  it("routes an MKV on WebKit desktop with the remux proxy available to remux", () => {
    const plan = planVodContainerPlayback("https://host.example/movie.mkv", webkitDesktop)
    expect(plan).toEqual({ mode: "remux" })
  })

  it("routes an MKV on WebKit desktop without the remux proxy to unsupported", () => {
    const plan = planVodContainerPlayback("https://host.example/movie.mkv", {
      ...webkitDesktop,
      remuxAvailable: false,
    })
    expect(plan).toEqual({ mode: "unsupported", container: "mkv" })
  })

  it("routes an AVI on WebKit desktop to unsupported even when the remux proxy is available", () => {
    const plan = planVodContainerPlayback("https://host.example/movie.avi", webkitDesktop)
    expect(plan).toEqual({ mode: "unsupported", container: "avi" })
  })

  it("routes an MKV on Windows to direct when no prior attempt has proven it needs remuxing", () => {
    const plan = planVodContainerPlayback("https://host.example/movie.mkv", windowsDesktop)
    expect(plan).toEqual({ mode: "direct" })
  })

  it("routes an MKV on Windows to remux once forceRemux is set", () => {
    const plan = planVodContainerPlayback("https://host.example/movie.mkv", {
      ...windowsDesktop,
      forceRemux: true,
    })
    expect(plan).toEqual({ mode: "remux" })
  })

  it("routes an MKV on Windows with forceRemux to unsupported when the remux proxy isn't available", () => {
    const plan = planVodContainerPlayback("https://host.example/movie.mkv", {
      ...windowsDesktop,
      forceRemux: true,
      remuxAvailable: false,
    })
    expect(plan).toEqual({ mode: "unsupported", container: "mkv" })
  })

  it("routes an MKV on WebKit desktop to remux regardless of forceRemux", () => {
    expect(
      planVodContainerPlayback("https://host.example/movie.mkv", { ...webkitDesktop, forceRemux: false }),
    ).toEqual({ mode: "remux" })
    expect(
      planVodContainerPlayback("https://host.example/movie.mkv", { ...webkitDesktop, forceRemux: true }),
    ).toEqual({ mode: "remux" })
  })

  it("routes an AVI on Windows to unsupported, same as WebKit desktop", () => {
    const plan = planVodContainerPlayback("https://host.example/movie.avi", windowsDesktop)
    expect(plan).toEqual({ mode: "unsupported", container: "avi" })
  })

  it("stays direct on Windows for HLS and MP4 sources", () => {
    expect(planVodContainerPlayback("https://host.example/master.m3u8", windowsDesktop)).toEqual({
      mode: "direct",
    })
    expect(planVodContainerPlayback("https://host.example/movie.mp4", windowsDesktop)).toEqual({
      mode: "direct",
    })
  })

  it("stays direct when not on a Tauri desktop (web, Android), regardless of container, platform or forceRemux", () => {
    const nonDesktopEnvs = [
      { ...webkitDesktop, isTauriDesktop: false },
      { ...windowsDesktop, isTauriDesktop: false },
      { ...windowsDesktop, isTauriDesktop: false, forceRemux: true },
      { ...windowsDesktop, isTauriDesktop: false, remuxAvailable: false },
    ]
    for (const env of nonDesktopEnvs) {
      expect(planVodContainerPlayback("https://host.example/movie.mkv", env)).toEqual({ mode: "direct" })
      expect(planVodContainerPlayback("https://host.example/movie.avi", env)).toEqual({ mode: "direct" })
    }
  })

  it("stays direct for HLS and MP4 sources on WebKit desktop", () => {
    expect(planVodContainerPlayback("https://host.example/master.m3u8", webkitDesktop)).toEqual({
      mode: "direct",
    })
    expect(planVodContainerPlayback("https://host.example/movie.mp4", webkitDesktop)).toEqual({
      mode: "direct",
    })
  })

  it("detects the container through a query string", () => {
    const plan = planVodContainerPlayback("https://host.example/movie.mkv?token=abc&expires=1", webkitDesktop)
    expect(plan).toEqual({ mode: "remux" })
  })

  it("detects the container case-insensitively", () => {
    expect(planVodContainerPlayback("https://host.example/Movie.MKV", webkitDesktop)).toEqual({
      mode: "remux",
    })
    expect(planVodContainerPlayback("https://host.example/Movie.AVI", webkitDesktop)).toEqual({
      mode: "unsupported",
      container: "avi",
    })
  })

  it("stays direct for a URL it can't parse", () => {
    const plan = planVodContainerPlayback("not a url", webkitDesktop)
    expect(plan).toEqual({ mode: "direct" })
  })

  it("stays direct for a non-http(s) protocol even with an mkv extension", () => {
    const plan = planVodContainerPlayback("asset://localhost/movie.mkv", webkitDesktop)
    expect(plan).toEqual({ mode: "direct" })
  })
})

describe("detectVodContainer", () => {
  it("returns mkv for a .mkv URL with a query string", () => {
    expect(detectVodContainer("https://host.example/movie.mkv?token=abc")).toBe("mkv")
  })

  it("returns avi for a .AVI URL regardless of case", () => {
    expect(detectVodContainer("https://host.example/movie.AVI")).toBe("avi")
  })

  it("returns null for an unrelated extension", () => {
    expect(detectVodContainer("https://host.example/movie.mp4")).toBeNull()
  })

  it("returns null for an unparseable URL", () => {
    expect(detectVodContainer("not a url")).toBeNull()
  })
})

describe("detectVodContainerFromLocalPath", () => {
  it("returns mkv for a bare filesystem path with no URL scheme", () => {
    expect(detectVodContainerFromLocalPath("/Users/ludo/Downloads/Movie.mkv")).toBe("mkv")
  })

  it("returns avi case-insensitively", () => {
    expect(detectVodContainerFromLocalPath("C:\\Downloads\\Movie.AVI")).toBe("avi")
  })

  it("returns null for an unrelated extension", () => {
    expect(detectVodContainerFromLocalPath("/Users/ludo/Downloads/Movie.mp4")).toBeNull()
  })

  it("returns null for empty or non-string input", () => {
    expect(detectVodContainerFromLocalPath("")).toBeNull()
    expect(detectVodContainerFromLocalPath(undefined as unknown as string)).toBeNull()
  })
})

describe("planLocalVodContainerPlayback", () => {
  it("routes a locally downloaded MKV on WebKit desktop to remux, unlike its asset URL", () => {
    // The asset.localhost/asset:// mount URL wouldn't detect as mkv (see the
    // "non-http(s) protocol" case in planVodContainerPlayback above); the local path does.
    const plan = planLocalVodContainerPlayback("/Users/ludo/Downloads/Movie.mkv", webkitDesktop)
    expect(plan).toEqual({ mode: "remux" })
  })

  it("routes a locally downloaded AVI on WebKit desktop to unsupported", () => {
    const plan = planLocalVodContainerPlayback("/Users/ludo/Downloads/Movie.avi", webkitDesktop)
    expect(plan).toEqual({ mode: "unsupported", container: "avi" })
  })

  it("routes a locally downloaded MKV on Windows to direct until forceRemux is set", () => {
    expect(
      planLocalVodContainerPlayback("C:\\Downloads\\Movie.mkv", windowsDesktop),
    ).toEqual({ mode: "direct" })
    expect(
      planLocalVodContainerPlayback("C:\\Downloads\\Movie.mkv", { ...windowsDesktop, forceRemux: true }),
    ).toEqual({ mode: "remux" })
  })

  it("routes a locally downloaded AVI on Windows to unsupported", () => {
    const plan = planLocalVodContainerPlayback("C:\\Downloads\\Movie.avi", windowsDesktop)
    expect(plan).toEqual({ mode: "unsupported", container: "avi" })
  })

  it("stays direct for an mp4 download", () => {
    const plan = planLocalVodContainerPlayback("/Users/ludo/Downloads/Movie.mp4", webkitDesktop)
    expect(plan).toEqual({ mode: "direct" })
  })
})

describe("isUpstreamHttpFailure", () => {
  it("matches ffmpeg's 'HTTP error 4xx/5xx' phrasing", () => {
    expect(isUpstreamHttpFailure("OTHER:ffmpeg exited with exit status: 1\nHTTP error 404 Not Found")).toBe(true)
  })

  it("matches ffmpeg's 'Server returned 4xx/5xx' phrasing", () => {
    expect(isUpstreamHttpFailure("OTHER:ffmpeg exited with exit status: 1\nServer returned 503 Service Unavailable")).toBe(
      true,
    )
  })

  it("does not match unrelated ffmpeg failures", () => {
    expect(isUpstreamHttpFailure("TIMEOUT:no output from ffmpeg for 10s")).toBe(false)
  })

  it("returns false for a non-string detail", () => {
    expect(isUpstreamHttpFailure(undefined as unknown as string)).toBe(false)
  })
})
