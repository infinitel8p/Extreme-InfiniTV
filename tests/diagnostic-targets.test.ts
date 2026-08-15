import { describe, it, expect } from "vitest"
import {
  extractM3UHeaderEpgUrl,
  firstStreamUrlFromM3U,
  isAbsoluteHttpUrl,
  pickSampleLiveStreamId,
} from "../src/scripts/lib/diagnostic-targets"

describe("extractM3UHeaderEpgUrl", () => {
  it("reads a double-quoted url-tvg value", () => {
    const text = '#EXTM3U url-tvg="https://example.com/epg.xml"\n#EXTINF:-1,Ch\nhttp://example.com/1.m3u8\n'
    expect(extractM3UHeaderEpgUrl(text)).toBe("https://example.com/epg.xml")
  })

  it("reads an unquoted value", () => {
    const text = "#EXTM3U url-tvg=https://example.com/epg.xml\n"
    expect(extractM3UHeaderEpgUrl(text)).toBe("https://example.com/epg.xml")
  })

  it("falls back to tvg-url when x-tvg-url is absent", () => {
    const text = '#EXTM3U tvg-url="https://example.com/tvgurl.xml"\n'
    expect(extractM3UHeaderEpgUrl(text)).toBe("https://example.com/tvgurl.xml")
  })

  it("falls back to url-tvg when neither x-tvg-url nor tvg-url is present", () => {
    const text = '#EXTM3U url-tvg="https://example.com/win.xml"\n'
    expect(extractM3UHeaderEpgUrl(text)).toBe("https://example.com/win.xml")
  })

  it("prefers x-tvg-url over tvg-url and url-tvg when several are present", () => {
    const text =
      '#EXTM3U tvg-url="https://example.com/tvgurl.xml" x-tvg-url="https://example.com/xtvg.xml" url-tvg="https://example.com/win.xml"\n'
    expect(extractM3UHeaderEpgUrl(text)).toBe("https://example.com/xtvg.xml")
  })

  it("returns only the first URL of a comma-separated multi-source value", () => {
    const text = '#EXTM3U url-tvg="https://example.com/a.xml,https://example.com/b.xml"\n'
    expect(extractM3UHeaderEpgUrl(text)).toBe("https://example.com/a.xml")
  })

  it("strips a leading UTF-8 BOM and handles CRLF", () => {
    const text = "﻿#EXTM3U url-tvg=\"https://example.com/epg.xml\"\r\n#EXTINF:-1,Ch\r\nhttp://example.com/1.m3u8\r\n"
    expect(extractM3UHeaderEpgUrl(text)).toBe("https://example.com/epg.xml")
  })

  it("returns null when no EPG attribute is present", () => {
    expect(extractM3UHeaderEpgUrl("#EXTM3U\n#EXTINF:-1,Ch\nhttp://example.com/1.m3u8\n")).toBeNull()
  })

  it("returns null when the value is not an http(s) URL", () => {
    const text = '#EXTM3U url-tvg="not-a-url"\n'
    expect(extractM3UHeaderEpgUrl(text)).toBeNull()
  })

  it("returns null when the attribute appears on a later line, not the header", () => {
    const text = '#EXTM3U\n#EXTINF:-1 tvg-url="https://example.com/late.xml",Ch\nhttp://example.com/1.m3u8\n'
    expect(extractM3UHeaderEpgUrl(text)).toBeNull()
  })

  it("keeps a comma inside the first URL's query string intact instead of truncating it", () => {
    const text = '#EXTM3U url-tvg="http://epg.example.com/guide.xml?ids=1,2"\n'
    expect(extractM3UHeaderEpgUrl(text)).toBe("http://epg.example.com/guide.xml?ids=1,2")
  })

  it("keeps a protocol-relative value as a single URL", () => {
    const text = '#EXTM3U url-tvg="//epg.example.com/epg.xml"\n'
    expect(extractM3UHeaderEpgUrl(text)).toBe("//epg.example.com/epg.xml")
  })

  it("keeps a comma inside the first URL's query string when a protocol-relative source follows", () => {
    const text = '#EXTM3U url-tvg="http://epg.example.com/guide.xml?ids=1,2,//b.example/2.xml"\n'
    expect(extractM3UHeaderEpgUrl(text)).toBe("http://epg.example.com/guide.xml?ids=1,2")
  })
})

describe("firstStreamUrlFromM3U", () => {
  it("returns the first stream URL after the header and EXTINF lines", () => {
    const text =
      "#EXTM3U\n#EXTINF:-1 tvg-id=\"x\",Channel One\nhttp://example.com/1.m3u8\n#EXTINF:-1,Channel Two\nhttp://example.com/2.m3u8\n"
    expect(firstStreamUrlFromM3U(text)).toBe("http://example.com/1.m3u8")
  })

  it("returns null for a comment-only playlist", () => {
    expect(firstStreamUrlFromM3U("#EXTM3U\n#EXTINF:-1,Channel One\n")).toBeNull()
  })

  it("skips blank lines and handles CRLF", () => {
    const text = "#EXTM3U\r\n\r\n#EXTINF:-1,Channel\r\n\r\nhttp://example.com/1.m3u8\r\n"
    expect(firstStreamUrlFromM3U(text)).toBe("http://example.com/1.m3u8")
  })

  it("strips a leading UTF-8 BOM", () => {
    const text = "﻿#EXTM3U\n#EXTINF:-1,Channel\nhttp://example.com/1.m3u8\n"
    expect(firstStreamUrlFromM3U(text)).toBe("http://example.com/1.m3u8")
  })

  it("trims leading whitespace off the stream line", () => {
    const text = "#EXTM3U\n#EXTINF:-1,Channel\n   http://example.com/1.m3u8\n"
    expect(firstStreamUrlFromM3U(text)).toBe("http://example.com/1.m3u8")
  })
})

describe("isAbsoluteHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isAbsoluteHttpUrl("http://example.com/1.m3u8")).toBe(true)
    expect(isAbsoluteHttpUrl("https://example.com/1.m3u8")).toBe(true)
  })

  it("rejects a relative path, so a bare M3U line can't be probed against the app's own origin", () => {
    expect(isAbsoluteHttpUrl("/1.m3u8")).toBe(false)
    expect(isAbsoluteHttpUrl("1.m3u8")).toBe(false)
  })

  it("rejects null, undefined, and empty string", () => {
    expect(isAbsoluteHttpUrl(null)).toBe(false)
    expect(isAbsoluteHttpUrl(undefined)).toBe(false)
    expect(isAbsoluteHttpUrl("")).toBe(false)
  })
})

describe("pickSampleLiveStreamId", () => {
  it("reads from a plain top-level array", () => {
    expect(pickSampleLiveStreamId([{ stream_id: 101 }, { stream_id: 102 }])).toBe("101")
  })

  it("reads from an object with a streams array", () => {
    expect(pickSampleLiveStreamId({ streams: [{ stream_id: 55 }] })).toBe("55")
  })

  it("reads from an object with a results array", () => {
    expect(pickSampleLiveStreamId({ results: [{ stream_id: 77 }] })).toBe("77")
  })

  it("accepts a numeric stream_id", () => {
    expect(pickSampleLiveStreamId([{ stream_id: 9 }])).toBe("9")
  })

  it("accepts a numeric-looking string stream_id", () => {
    expect(pickSampleLiveStreamId([{ stream_id: "42" }])).toBe("42")
  })

  it("falls through an unusable first element to the second", () => {
    const payload = [{ stream_id: null }, { stream_id: "not-a-number" }, { stream_id: 7 }]
    expect(pickSampleLiveStreamId(payload)).toBe("7")
  })

  it("returns null for an empty array", () => {
    expect(pickSampleLiveStreamId([])).toBeNull()
  })

  it("returns null for null, undefined, string, and number payloads", () => {
    expect(pickSampleLiveStreamId(null)).toBeNull()
    expect(pickSampleLiveStreamId(undefined)).toBeNull()
    expect(pickSampleLiveStreamId("nope")).toBeNull()
    expect(pickSampleLiveStreamId(42)).toBeNull()
  })

  it("returns null when every element is missing stream_id", () => {
    expect(pickSampleLiveStreamId([{ name: "Channel" }, { name: "Other" }])).toBeNull()
  })
})
