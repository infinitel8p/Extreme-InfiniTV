import { describe, it, expect } from "vitest"
import {
  serializeChannelsForActivity,
  serializeChannelsJson,
  sliceSiblingWindow,
} from "@/scripts/lib/channel-lite.js"

const fixedNow = Date.UTC(2026, 4, 17, 12, 0, 0)

describe("serializeChannelsForActivity", () => {
  it("drops entries without a streamUrl", () => {
    const out = serializeChannelsForActivity([
      { id: 1, name: "A", streamUrl: "https://example.test/a.m3u8" },
      { id: 2, name: "B", streamUrl: "" },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe("A")
  })

  it("normalizes id to string and fills empty string defaults", () => {
    const out = serializeChannelsForActivity([
      { id: 42, name: "Numeric", streamUrl: "https://x/y.m3u8" },
    ])
    expect(out[0].id).toBe("42")
    expect(out[0].logo).toBe("")
    expect(out[0].ua).toBe("")
    expect(out[0].referer).toBe("")
    expect(out[0].nowProgramme).toBe("")
  })

  it("applies defaultUa when channel has none", () => {
    const out = serializeChannelsForActivity(
      [{ id: 1, name: "A", streamUrl: "https://x/a.m3u8" }],
      { defaultUa: "FallbackUA/1.0" },
    )
    expect(out[0].ua).toBe("FallbackUA/1.0")
  })

  it("prefers per-channel UA over defaultUa", () => {
    const out = serializeChannelsForActivity(
      [{ id: 1, name: "A", streamUrl: "https://x/a.m3u8", ua: "ChannelUA/2.0" }],
      { defaultUa: "FallbackUA/1.0" },
    )
    expect(out[0].ua).toBe("ChannelUA/2.0")
  })

  it("fills nowProgramme from the programmes map when tvgId resolves", () => {
    const programmes = new Map<string, Array<{ start: number; stop: number; title: string; desc: string }>>([
      [
        "bbc.one",
        [{ start: fixedNow - 60_000, stop: fixedNow + 60_000, title: "News at Noon", desc: "" }],
      ],
    ])
    const out = serializeChannelsForActivity(
      [{ id: 1, name: "BBC One", streamUrl: "https://x/bbc.m3u8", tvgId: "bbc.one" }],
      { programmes, atMs: fixedNow },
    )
    expect(out[0].nowProgramme).toBe("Now: News at Noon")
  })

  it("applies tvgShift before resolving nowProgramme", () => {
    const programmes = new Map<string, Array<{ start: number; stop: number; title: string; desc: string }>>([
      [
        "bbc.one",
        [{ start: fixedNow + 3_600_000, stop: fixedNow + 7_200_000, title: "News at One", desc: "" }],
      ],
    ])
    const out = serializeChannelsForActivity(
      [{ id: 1, name: "BBC One", streamUrl: "https://x/bbc.m3u8", tvgId: "bbc.one", tvgShift: -1 }],
      { programmes, atMs: fixedNow },
    )
    expect(out[0].nowProgramme).toBe("Now: News at One")
  })

  it("leaves nowProgramme empty when no programmes provided", () => {
    const out = serializeChannelsForActivity(
      [{ id: 1, name: "A", streamUrl: "https://x/a.m3u8", tvgId: "x.y" }],
      { programmes: null, atMs: fixedNow },
    )
    expect(out[0].nowProgramme).toBe("")
  })

  it("leaves nowProgramme empty when tvgId has no entry in programmes", () => {
    const programmes = new Map([["other.id", [{ start: 0, stop: 0, title: "ignored", desc: "" }]]])
    const out = serializeChannelsForActivity(
      [{ id: 1, name: "A", streamUrl: "https://x/a.m3u8", tvgId: "missing.id" }],
      { programmes, atMs: fixedNow },
    )
    expect(out[0].nowProgramme).toBe("")
  })
})

describe("sliceSiblingWindow", () => {
  const channels = Array.from({ length: 500 }, (_, index) => index)

  it("returns everything when the list is smaller than the window", () => {
    expect(sliceSiblingWindow([1, 2, 3], 1, 100)).toEqual([1, 2, 3])
  })

  it("centers the window on the current index", () => {
    const windowed = sliceSiblingWindow(channels, 250, 100)
    expect(windowed).toHaveLength(201)
    expect(windowed[0]).toBe(150)
    expect(windowed[windowed.length - 1]).toBe(350)
  })

  it("clamps the window at the start of the list", () => {
    const windowed = sliceSiblingWindow(channels, 0, 100)
    expect(windowed[0]).toBe(0)
    expect(windowed).toHaveLength(101)
  })

  it("clamps the window at the end of the list", () => {
    const windowed = sliceSiblingWindow(channels, 499, 100)
    expect(windowed[windowed.length - 1]).toBe(499)
    expect(windowed).toHaveLength(101)
  })

  it("falls back to the leading window when the index is out of range", () => {
    const windowed = sliceSiblingWindow(channels, -1, 100)
    expect(windowed[0]).toBe(0)
    expect(windowed).toHaveLength(201)
  })

  it("returns an empty array for an empty list", () => {
    expect(sliceSiblingWindow([], 0, 100)).toEqual([])
  })
})

describe("serializeChannelsJson", () => {
  it("produces valid JSON that round-trips back to the same shape", () => {
    const json = serializeChannelsJson([
      { id: 1, name: "A", streamUrl: "https://x/a.m3u8", logo: "https://x/a.png" },
    ])
    expect(() => JSON.parse(json)).not.toThrow()
    const parsed = JSON.parse(json)
    expect(parsed[0]).toMatchObject({
      id: "1",
      name: "A",
      streamUrl: "https://x/a.m3u8",
      logo: "https://x/a.png",
    })
  })
})
