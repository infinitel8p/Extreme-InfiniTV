import { describe, it, expect } from "vitest"
import {
  DEFAULT_CATCHUP_DAYS,
  channelSupportsCatchup,
  catchupWindowDays,
  isCatchupPlayable,
  formatTimeshiftStart,
  clampedDurationMinutes,
  buildXtreamTimeshiftUrl,
  computeServerOffsetMs,
  expandCatchupTemplate,
  buildM3uCatchupUrl,
  parseXtreamStyleLiveUrl,
  type CatchupCapableChannel,
} from "../src/scripts/lib/catchup"

describe("formatTimeshiftStart", () => {
  it("zero-pads month, day, hour, and minute", () => {
    const startUtcMs = Date.UTC(2024, 3, 5, 7, 5, 0)
    expect(formatTimeshiftStart(startUtcMs, 0)).toBe("2024-04-05:07-05")
  })

  it("rolls over to the next day with a positive offset", () => {
    const startUtcMs = Date.UTC(2024, 0, 1, 23, 50, 0)
    expect(formatTimeshiftStart(startUtcMs, 2 * 3600000)).toBe("2024-01-02:01-50")
  })

  it("rolls back to the previous day with a negative offset", () => {
    const startUtcMs = Date.UTC(2024, 0, 2, 0, 10, 0)
    expect(formatTimeshiftStart(startUtcMs, -3 * 3600000)).toBe("2024-01-01:21-10")
  })
})

describe("clampedDurationMinutes", () => {
  it("returns the plain duration when the programme already ended", () => {
    expect(clampedDurationMinutes(0, 600000, 1000000)).toBe(10)
  })

  it("clamps an in-progress programme to now", () => {
    expect(clampedDurationMinutes(0, 3600000, 900000)).toBe(15)
  })

  it("never returns less than one minute", () => {
    expect(clampedDurationMinutes(100000, 200000, 100000)).toBe(1)
  })
})

describe("buildXtreamTimeshiftUrl", () => {
  const startUtcMs = Date.UTC(2024, 5, 15, 20, 30, 0)

  it("builds the REST/path form and encodes special characters", () => {
    const url = buildXtreamTimeshiftUrl({
      baseUrl: "http://host.example:8080/",
      username: "user one",
      password: "pa:ss",
      streamId: 501,
      startUtcMs,
      durationMinutes: 90,
      serverOffsetMs: 0,
      extension: "ts",
      form: "rest",
    })
    expect(url).toBe(
      "http://host.example:8080/timeshift/user%20one/pa%3Ass/90/2024-06-15:20-30/501.ts",
    )
  })

  it("builds the legacy query form and encodes special characters", () => {
    const url = buildXtreamTimeshiftUrl({
      baseUrl: "http://host.example:8080",
      username: "user one",
      password: "pa:ss",
      streamId: 501,
      startUtcMs,
      durationMinutes: 90,
      serverOffsetMs: 0,
      extension: "m3u8",
      form: "legacy",
    })
    expect(url).toBe(
      "http://host.example:8080/streaming/timeshift.php?username=user%20one&password=pa%3Ass&stream=501&start=2024-06-15%3A20-30&duration=90",
    )
  })
})

describe("computeServerOffsetMs", () => {
  const nowMs = Date.UTC(2024, 0, 1, 0, 0, 0)
  const nowSec = nowMs / 1000

  it("computes drift when the server is ahead of UTC", () => {
    const offset = computeServerOffsetMs(
      { time_now: "2024-01-01 02:00:00", timestamp_now: nowSec },
      nowMs,
    )
    expect(offset).toBe(2 * 3600000)
  })

  it("computes drift when the server is behind UTC", () => {
    const offset = computeServerOffsetMs(
      { time_now: "2023-12-31 19:00:00", timestamp_now: nowSec },
      nowMs,
    )
    expect(offset).toBe(-5 * 3600000)
  })

  it("rounds drift to the nearest 15 minutes", () => {
    // 5h07m of drift rounds down to the 5h00m bucket.
    const offset = computeServerOffsetMs(
      { time_now: "2024-01-01 05:07:00", timestamp_now: nowSec },
      nowMs,
    )
    expect(offset).toBe(5 * 3600000)
  })

  it("falls back to the IANA timezone offset in winter (CET, +1h)", () => {
    const winterNowMs = Date.UTC(2024, 0, 15, 12, 0, 0)
    const offset = computeServerOffsetMs({ timezone: "Europe/Berlin" }, winterNowMs)
    expect(offset).toBe(3600000)
  })

  it("falls back to the IANA timezone offset in summer (CEST, +2h)", () => {
    const summerNowMs = Date.UTC(2024, 6, 15, 12, 0, 0)
    const offset = computeServerOffsetMs({ timezone: "Europe/Berlin" }, summerNowMs)
    expect(offset).toBe(2 * 3600000)
  })

  it("returns 0 for an invalid timezone", () => {
    expect(computeServerOffsetMs({ timezone: "Not/AZone" }, nowMs)).toBe(0)
  })

  it("returns 0 when nothing usable is present", () => {
    expect(computeServerOffsetMs({}, nowMs)).toBe(0)
    expect(computeServerOffsetMs(null, nowMs)).toBe(0)
    expect(computeServerOffsetMs(undefined, nowMs)).toBe(0)
  })
})

describe("expandCatchupTemplate", () => {
  const startUtcMs = Date.UTC(2024, 0, 1, 0, 0, 0)
  const stopUtcMs = startUtcMs + 3600000
  const nowUtcMs = startUtcMs + 7200000
  const ctx = { startUtcMs, stopUtcMs, nowUtcMs }

  it("expands every placeholder from the table", () => {
    const template =
      "{utc}|${start}|{utcend}|${end}|{lutc}|${now}|${timestamp}|" +
      "{duration}|${duration}|{duration:1800}|${offset}|{offset:3600}|" +
      "{Y}-{m}-{d} {H}:{M}:{S}"
    const expected =
      "1704067200|1704067200|1704070800|1704070800|1704074400|1704074400|1704074400|" +
      "3600|3600|2|7200|2|" +
      "2024-01-01 00:00:00"
    expect(expandCatchupTemplate(template, ctx)).toBe(expected)
  })

  it("leaves unrecognized placeholders untouched", () => {
    expect(expandCatchupTemplate("{utc}-{bogus}", ctx)).toBe("1704067200-{bogus}")
  })
})

describe("expandCatchupTemplate ${(b)}/${(e)} device-local tokens", () => {
  const startUtcMs = new Date(2026, 5, 10, 12, 30, 0).getTime()
  const stopUtcMs = new Date(2026, 5, 10, 13, 30, 0).getTime()

  it("expands the TiviMate/diyp playseek template with begin and end instants", () => {
    const nowUtcMs = stopUtcMs
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs }
    expect(expandCatchupTemplate("?playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}", ctx)).toBe(
      "?playseek=20260610123000-20260610133000",
    )
  })

  it("clamps the (e) end instant to now when the programme is still in progress", () => {
    const nowUtcMs = new Date(2026, 5, 10, 13, 0, 0).getTime()
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs }
    expect(expandCatchupTemplate("${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}", ctx)).toBe(
      "20260610123000-20260610130000",
    )
  })

  it("formats a mixed/unpadded pattern correctly", () => {
    const nowUtcMs = stopUtcMs
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs }
    expect(expandCatchupTemplate("${(b)yyyy-MM-dd H:m:s}", ctx)).toBe("2026-06-10 12:30:0")
  })

  it("leaves unrecognized ${(x)...} placeholders untouched", () => {
    const nowUtcMs = stopUtcMs
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs }
    expect(expandCatchupTemplate("${(x)yyyyMMdd}-{bogus}", ctx)).toBe("${(x)yyyyMMdd}-{bogus}")
  })
})

describe("buildM3uCatchupUrl", () => {
  const startUtcMs = Date.UTC(2024, 0, 1, 0, 0, 0)
  const stopUtcMs = startUtcMs + 3600000
  const nowUtcMs = startUtcMs + 7200000
  const ctx = { startUtcMs, stopUtcMs, nowUtcMs }

  it("expands catchup-source as the full URL in default mode", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host/live.m3u8",
      catchup: "default",
      catchupSource: "http://host/archive?utc={utc}",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe("http://host/archive?utc=1704067200")
  })

  it("falls back to shift behavior in default mode without a source", () => {
    const channel: CatchupCapableChannel = { url: "http://host/live.m3u8", catchup: "default" }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://host/live.m3u8?utc=1704067200&lutc=1704074400",
    )
  })

  it("appends the expanded catchup-source to the live URL in append mode", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host/live.m3u8",
      catchup: "append",
      catchupSource: "?utc={utc}&lutc={lutc}",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://host/live.m3u8?utc=1704067200&lutc=1704074400",
    )
  })

  it("appends an expanded ${(b)}/${(e)} playseek template in append mode", () => {
    const channel: CatchupCapableChannel = {
      url: "https://user:pass@host:33333/rtsp/1.2.3.4/PLTV/x/y/z/abc_0.smil",
      catchup: "append",
      catchupSource: "?playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}",
    }
    const startUtcMs = new Date(2026, 5, 10, 12, 30, 0).getTime()
    const stopUtcMs = new Date(2026, 5, 10, 13, 30, 0).getTime()
    const playseekCtx = { startUtcMs, stopUtcMs, nowUtcMs: stopUtcMs }
    expect(buildM3uCatchupUrl(channel, playseekCtx)).toBe(
      "https://user:pass@host:33333/rtsp/1.2.3.4/PLTV/x/y/z/abc_0.smil?playseek=20260610123000-20260610133000",
    )
  })

  it("falls through to shift behavior in append mode without a source", () => {
    const channel: CatchupCapableChannel = { url: "http://host/live.m3u8?token=abc", catchup: "append" }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://host/live.m3u8?token=abc&utc=1704067200&lutc=1704074400",
    )
  })

  it("appends utc/lutc in shift mode, respecting an existing query", () => {
    const withQuery: CatchupCapableChannel = { url: "http://host/live.m3u8?token=abc", catchup: "shift" }
    expect(buildM3uCatchupUrl(withQuery, ctx)).toBe(
      "http://host/live.m3u8?token=abc&utc=1704067200&lutc=1704074400",
    )
    const withoutQuery: CatchupCapableChannel = { url: "http://host/live.m3u8", catchup: "shift" }
    expect(buildM3uCatchupUrl(withoutQuery, ctx)).toBe(
      "http://host/live.m3u8?utc=1704067200&lutc=1704074400",
    )
  })

  it("treats the legacy timeshift mode as an alias for shift", () => {
    const channel: CatchupCapableChannel = { url: "http://host/live.m3u8", catchup: "timeshift" }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://host/live.m3u8?utc=1704067200&lutc=1704074400",
    )
  })

  it("builds a flussonic TS URL from a mpegts list", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host.example/12345/mpegts?token=xyz",
      catchup: "flussonic-ts",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://host.example/12345/timeshift_abs-1704067200.ts?token=xyz",
    )
  })

  it("builds a flussonic HLS URL from index.m3u8", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host.example/12345/index.m3u8",
      catchup: "flussonic-hls",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://host.example/12345/timeshift_rel-7200.m3u8",
    )
  })

  it("builds a flussonic HLS URL from a named list", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host.example/12345/mono.m3u8?x=1",
      catchup: "flussonic",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://host.example/12345/mono-timeshift_rel-7200.m3u8?x=1",
    )
  })

  it("forces the TS form for the fs alias regardless of list name", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host.example/12345/index.m3u8",
      catchup: "fs",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://host.example/12345/timeshift_abs-1704067200.ts",
    )
  })

  it("returns null for a flussonic URL that doesn't match the expected shape", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host.example/a/b/c/mpegts",
      catchup: "flussonic",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBeNull()
  })

  it("expands catchup-source as the full URL in vod mode", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host/live.m3u8",
      catchup: "vod",
      catchupSource: "http://vod.example/archive/{utc}.mp4",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe("http://vod.example/archive/1704067200.mp4")
  })

  it("returns null in vod mode without a source", () => {
    const channel: CatchupCapableChannel = { url: "http://host/live.m3u8", catchup: "vod" }
    expect(buildM3uCatchupUrl(channel, ctx)).toBeNull()
  })

  it("returns null for xc mode (caller builds the Xtream URL)", () => {
    const channel: CatchupCapableChannel = { url: "http://host/live.m3u8", catchup: "xc" }
    expect(buildM3uCatchupUrl(channel, ctx)).toBeNull()
  })

  it("returns null when the channel has no url", () => {
    const channel: CatchupCapableChannel = { catchup: "append" }
    expect(buildM3uCatchupUrl(channel, ctx)).toBeNull()
  })
})

describe("parseXtreamStyleLiveUrl", () => {
  it("parses a URL with the /live/ prefix", () => {
    expect(parseXtreamStyleLiveUrl("http://host.example:8080/live/user1/pass1/12345.m3u8")).toEqual({
      baseUrl: "http://host.example:8080",
      username: "user1",
      password: "pass1",
      streamId: "12345",
      extension: "m3u8",
    })
  })

  it("parses a URL without the /live/ prefix", () => {
    expect(parseXtreamStyleLiveUrl("http://host.example:8080/user1/pass1/12345.ts")).toEqual({
      baseUrl: "http://host.example:8080",
      username: "user1",
      password: "pass1",
      streamId: "12345",
      extension: "ts",
    })
  })

  it("defaults to a ts extension for a bare URL", () => {
    expect(parseXtreamStyleLiveUrl("http://host.example:8080/user1/pass1/12345")).toEqual({
      baseUrl: "http://host.example:8080",
      username: "user1",
      password: "pass1",
      streamId: "12345",
      extension: "ts",
    })
  })

  it("returns null for a URL that doesn't match the expected shape", () => {
    expect(parseXtreamStyleLiveUrl("http://host.example/not/enough")).toBeNull()
  })

  it("ignores a trailing query string after the extension", () => {
    expect(parseXtreamStyleLiveUrl("http://host.example:8080/live/user1/pass1/12345.m3u8?token=abc")).toEqual({
      baseUrl: "http://host.example:8080",
      username: "user1",
      password: "pass1",
      streamId: "12345",
      extension: "m3u8",
    })
  })

  it("ignores a trailing query string on a bare-id URL", () => {
    expect(parseXtreamStyleLiveUrl("http://host.example:8080/user1/pass1/12345?token=abc")).toEqual({
      baseUrl: "http://host.example:8080",
      username: "user1",
      password: "pass1",
      streamId: "12345",
      extension: "ts",
    })
  })
})

describe("channelSupportsCatchup", () => {
  it("recognizes the Xtream tvArchive flag as a string", () => {
    expect(channelSupportsCatchup({ tvArchive: "1" as unknown as number })).toBe(true)
  })

  it("recognizes the Xtream tvArchive flag as a number", () => {
    expect(channelSupportsCatchup({ tvArchive: 1 })).toBe(true)
  })

  it("recognizes a truthy M3U catchup attribute", () => {
    expect(channelSupportsCatchup({ catchup: "append" })).toBe(true)
  })

  it("recognizes a catchup-source with no catchup attribute", () => {
    expect(channelSupportsCatchup({ catchupSource: "?utc={utc}" })).toBe(true)
  })

  it("returns false when nothing indicates catchup support", () => {
    expect(channelSupportsCatchup({ tvArchive: 0 })).toBe(false)
    expect(channelSupportsCatchup({})).toBe(false)
  })
})

describe("catchupWindowDays", () => {
  it("uses the Xtream archive duration when positive", () => {
    expect(catchupWindowDays({ tvArchiveDuration: 14 })).toBe(14)
  })

  it("falls back to the M3U catchup-days when the archive duration is unset", () => {
    expect(catchupWindowDays({ tvArchiveDuration: 0, catchupDays: 10 })).toBe(10)
  })

  it("defaults to DEFAULT_CATCHUP_DAYS when neither is positive", () => {
    expect(catchupWindowDays({})).toBe(DEFAULT_CATCHUP_DAYS)
    expect(catchupWindowDays({ catchupDays: 0 })).toBe(DEFAULT_CATCHUP_DAYS)
  })
})

describe("isCatchupPlayable", () => {
  const nowMs = 1_000_000_000_000
  const windowMs = DEFAULT_CATCHUP_DAYS * 24 * 60 * 60 * 1000
  const channel: CatchupCapableChannel = { catchup: "append" }

  it("is playable just inside the window", () => {
    expect(isCatchupPlayable(channel, nowMs - windowMs + 1, nowMs)).toBe(true)
  })

  it("is playable exactly at the window boundary", () => {
    expect(isCatchupPlayable(channel, nowMs - windowMs, nowMs)).toBe(true)
  })

  it("is not playable just outside the window", () => {
    expect(isCatchupPlayable(channel, nowMs - windowMs - 1, nowMs)).toBe(false)
  })

  it("is not playable for a programme starting right now or in the future", () => {
    expect(isCatchupPlayable(channel, nowMs, nowMs)).toBe(false)
    expect(isCatchupPlayable(channel, nowMs + 1000, nowMs)).toBe(false)
  })

  it("is not playable when the channel does not support catchup", () => {
    expect(isCatchupPlayable({}, nowMs - 1000, nowMs)).toBe(false)
  })
})
