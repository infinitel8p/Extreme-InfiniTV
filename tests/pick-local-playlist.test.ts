import { describe, it, expect, vi } from "vitest"

vi.mock("@/scripts/lib/android-fs.js", () => ({
  isAndroidFsActive: () => false,
  pickM3UFile: vi.fn(),
}))

vi.mock("@/scripts/lib/creds.js", () => ({ isTauri: false }))

import { validatePickedPlaylist, MAX_LOCAL_M3U_BYTES } from "@/scripts/lib/pick-local-playlist"

describe("validatePickedPlaylist", () => {
  it("rejects an oversize pick with the size", () => {
    const result = validatePickedPlaylist({ name: "big.m3u", text: "", size: 123, oversize: true })
    expect(result).toEqual({ ok: false, reasonKey: "login.status.localTooLarge", size: 123 })
  })

  it("rejects an oversize pick of unknown size with the unknown-size key", () => {
    const result = validatePickedPlaylist({ name: "", text: "", size: 0, oversize: true })
    expect(result).toEqual({ ok: false, reasonKey: "login.status.localTooLargeUnknown" })
  })

  it("rejects when reported size exceeds the limit", () => {
    const size = MAX_LOCAL_M3U_BYTES + 1
    const result = validatePickedPlaylist({ name: "big.m3u", text: "#EXTM3U", size })
    expect(result).toEqual({ ok: false, reasonKey: "login.status.localTooLarge", size })
  })

  it("rejects empty text", () => {
    const result = validatePickedPlaylist({ name: "a.m3u", text: "", size: 0 })
    expect(result).toEqual({ ok: false, reasonKey: "login.status.localEmpty" })
  })

  it("rejects an HLS stream manifest", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:10",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXTINF:10.0,",
      "seg0.ts",
      "#EXTINF:10.0,",
      "seg1.ts",
    ].join("\n")
    const result = validatePickedPlaylist({ name: "stream.m3u8", text, size: text.length })
    expect(result).toEqual({ ok: false, reasonKey: "login.status.localNotM3u" })
  })

  it("rejects random non-M3U text", () => {
    const text = "hello world, this is not a playlist"
    const result = validatePickedPlaylist({ name: "notes.txt", text, size: text.length })
    expect(result).toEqual({ ok: false, reasonKey: "login.status.localNotM3u" })
  })

  it("accepts a valid playlist and reports entries and EPG url", () => {
    const text = [
      '#EXTM3U url-tvg="http://x/epg.xml"',
      '#EXTINF:-1 tvg-id="a" group-title="News",Channel A',
      "http://example.com/a.m3u8",
      '#EXTINF:-1 tvg-id="b" group-title="News",Channel B',
      "http://example.com/b.m3u8",
    ].join("\n")
    const result = validatePickedPlaylist({ name: "list.m3u", text, size: text.length })
    expect(result).toEqual({ ok: true, entryCount: 2, epgUrl: "http://x/epg.xml" })
  })
})
