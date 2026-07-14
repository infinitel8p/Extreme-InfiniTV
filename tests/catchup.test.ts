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
  templateHasEndToken,
  templateUsesPlayseek,
  streamProfileFor,
  XTREAM_STREAM_PROFILE,
  type CatchupCapableChannel,
} from "../src/scripts/lib/catchup"

function padTwo(value: number): string {
  return String(value).padStart(2, "0")
}

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

  it("shifts the REST-form start earlier for a positive catchupCorrectionMs, duration unchanged", () => {
    const url = buildXtreamTimeshiftUrl({
      baseUrl: "http://host.example:8080",
      username: "user",
      password: "pass",
      streamId: 501,
      startUtcMs,
      durationMinutes: 90,
      serverOffsetMs: 0,
      extension: "ts",
      form: "rest",
      catchupCorrectionMs: 2 * 3600000,
    })
    expect(url).toBe("http://host.example:8080/timeshift/user/pass/90/2024-06-15:18-30/501.ts")
  })

  it("shifts the legacy-form start earlier for a positive catchupCorrectionMs, duration unchanged", () => {
    const url = buildXtreamTimeshiftUrl({
      baseUrl: "http://host.example:8080",
      username: "user",
      password: "pass",
      streamId: 501,
      startUtcMs,
      durationMinutes: 90,
      serverOffsetMs: 0,
      extension: "m3u8",
      form: "legacy",
      catchupCorrectionMs: 2 * 3600000,
    })
    expect(url).toBe(
      "http://host.example:8080/streaming/timeshift.php?username=user&password=pass&stream=501&start=2024-06-15%3A18-30&duration=90",
    )
  })

  it("shifts the start later for a negative catchupCorrectionMs", () => {
    const url = buildXtreamTimeshiftUrl({
      baseUrl: "http://host.example:8080",
      username: "user",
      password: "pass",
      streamId: 501,
      startUtcMs,
      durationMinutes: 90,
      serverOffsetMs: 0,
      extension: "ts",
      form: "rest",
      catchupCorrectionMs: -1800000,
    })
    expect(url).toBe("http://host.example:8080/timeshift/user/pass/90/2024-06-15:21-00/501.ts")
  })

  it("composes a catchupCorrectionMs shift with a serverOffsetMs shift", () => {
    const url = buildXtreamTimeshiftUrl({
      baseUrl: "http://host.example:8080",
      username: "user",
      password: "pass",
      streamId: 501,
      startUtcMs,
      durationMinutes: 90,
      serverOffsetMs: 3600000,
      extension: "ts",
      form: "rest",
      catchupCorrectionMs: 2 * 3600000,
    })
    expect(url).toBe("http://host.example:8080/timeshift/user/pass/90/2024-06-15:19-30/501.ts")
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
    // {Y}/{m}/{d}/{H}/{M}/{S} render the LOCAL time of the start instant (Kodi parity), so the
    // expected value is computed via local Date getters to stay timezone-independent.
    const startDate = new Date(startUtcMs)
    const localStart =
      `${startDate.getFullYear()}-${padTwo(startDate.getMonth() + 1)}-${padTwo(startDate.getDate())} ` +
      `${padTwo(startDate.getHours())}:${padTwo(startDate.getMinutes())}:${padTwo(startDate.getSeconds())}`
    const template =
      "{utc}|${start}|{utcend}|${end}|{lutc}|${now}|${timestamp}|" +
      "{duration}|${duration}|{duration:1800}|${offset}|{offset:3600}|" +
      "{Y}-{m}-{d} {H}:{M}:{S}"
    const expected =
      "1704067200|1704067200|1704070800|1704070800|1704074400|1704074400|1704074400|" +
      `3600|3600|2|7200|2|${localStart}`
    expect(expandCatchupTemplate(template, ctx)).toBe(expected)
  })

  // Kodi only replaces the first occurrence of each token; we deliberately replace every
  // occurrence, which is the more useful behavior for templates that repeat a placeholder.
  it("replaces every occurrence of a repeated epoch token, not just the first", () => {
    expect(expandCatchupTemplate("{utc}-{utc}", ctx)).toBe("1704067200-1704067200")
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

  it("clamps the (e) end instant to now when the programme is still in progress (non-playseek template)", () => {
    const nowUtcMs = new Date(2026, 5, 10, 13, 0, 0).getTime()
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs }
    expect(expandCatchupTemplate("${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}", ctx)).toBe(
      "20260610123000-20260610130000",
    )
  })

  it("leaves the (e) end instant unclamped for a playseek template on a still-airing programme", () => {
    const nowUtcMs = new Date(2026, 5, 10, 13, 0, 0).getTime()
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs }
    expect(
      expandCatchupTemplate("?playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}", ctx),
    ).toBe("?playseek=20260610123000-20260610133000")
  })

  it("expands {utcend} and {duration} to the real (unclamped) programme end for a playseek template still in progress", () => {
    const nowUtcMs = new Date(2026, 5, 10, 13, 10, 0).getTime()
    const stillAiringStopUtcMs = new Date(2026, 5, 10, 13, 30, 0).getTime()
    const ctx = { startUtcMs, stopUtcMs: stillAiringStopUtcMs, nowUtcMs }
    const expectedEndSec = Math.floor(stillAiringStopUtcMs / 1000)
    const expectedDurationSec = Math.floor((stillAiringStopUtcMs - startUtcMs) / 1000)
    expect(expandCatchupTemplate("?playseek={utc}-{utcend}&d={duration}", ctx)).toBe(
      `?playseek=${Math.floor(startUtcMs / 1000)}-${expectedEndSec}&d=${expectedDurationSec}`,
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

// Kodi-derived vector setup shared by the colon-format, correction and catchup-id suites below.
describe("expandCatchupTemplate: colon-format tokens (rtp2httpd/Kodi parity)", () => {
  const startUtcMs = 1699999200 * 1000
  const stopUtcMs = 1700002800 * 1000
  const nowUtcMs = 1700006400 * 1000
  const ctx = { startUtcMs, stopUtcMs, nowUtcMs }

  function local14(ms: number): string {
    const date = new Date(ms)
    return (
      `${date.getFullYear()}${padTwo(date.getMonth() + 1)}${padTwo(date.getDate())}` +
      `${padTwo(date.getHours())}${padTwo(date.getMinutes())}${padTwo(date.getSeconds())}`
    )
  }

  it("expands {utc:YmdHMS}-{utcend:YmdHMS} using local-time components", () => {
    expect(expandCatchupTemplate("{utc:YmdHMS}-{utcend:YmdHMS}", ctx)).toBe(
      `${local14(startUtcMs)}-${local14(stopUtcMs)}`,
    )
  })

  it("passes non-YmdHMS characters through literally in a mixed pattern", () => {
    const startDate = new Date(startUtcMs)
    const expected =
      `${startDate.getFullYear()}${padTwo(startDate.getMonth() + 1)}${padTwo(startDate.getDate())}` +
      `-${padTwo(startDate.getHours())}-${padTwo(startDate.getMinutes())}`
    expect(expandCatchupTemplate("{utc:Ymd-H-M}", ctx)).toBe(expected)
  })

  it("supports the ${start:}/${end:} and {lutc:}/${now:}/${timestamp:} forms", () => {
    expect(expandCatchupTemplate("${start:YmdHMS}", ctx)).toBe(local14(startUtcMs))
    expect(expandCatchupTemplate("${end:YmdHMS}", ctx)).toBe(local14(stopUtcMs))
    expect(expandCatchupTemplate("{lutc:YmdHMS}", ctx)).toBe(local14(nowUtcMs))
    expect(expandCatchupTemplate("${now:YmdHMS}", ctx)).toBe(local14(nowUtcMs))
    expect(expandCatchupTemplate("${timestamp:YmdHMS}", ctx)).toBe(local14(nowUtcMs))
  })

  it("leaves the un-dollared {start:...} and dollared ${utc:...} forms unrecognized", () => {
    expect(expandCatchupTemplate("{start:YmdHMS}", ctx)).toBe("{start:YmdHMS}")
    expect(expandCatchupTemplate("${utc:YmdHMS}", ctx)).toBe("${utc:YmdHMS}")
  })

  it("bare {Y}{m}{d}{H}{M}{S} render in local time of the start instant", () => {
    expect(expandCatchupTemplate("{Y}{m}{d}{H}{M}{S}", ctx)).toBe(local14(startUtcMs))
  })
})

describe("expandCatchupTemplate: catchup-correction", () => {
  const startUtcMs = 1699999200 * 1000
  const stopUtcMs = 1700002800 * 1000
  const nowUtcMs = 1700006400 * 1000

  it("a positive correction shifts start/end earlier but leaves now/lutc raw", () => {
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs, catchupCorrectionHours: 2 }
    expect(expandCatchupTemplate("start={utc}&end={utcend}&lutc={lutc}&now=${now}", ctx)).toBe(
      "start=1699992000&end=1699995600&lutc=1700006400&now=1700006400",
    )
  })

  it("a negative correction shifts start/end later but leaves now/lutc raw", () => {
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs, catchupCorrectionHours: -0.5 }
    expect(expandCatchupTemplate("start={utc}&end={utcend}&lutc={lutc}", ctx)).toBe(
      "start=1700001000&end=1700004600&lutc=1700006400",
    )
  })

  // Kodi parity: FormatDateTime corrects the start/end operand but takes "now" straight from the
  // wall clock, so {offset} = rawNow - correctedStart grows with a positive correction (it reaches
  // further back into the archive) instead of cancelling out against a "corrected now".
  it("a positive correction grows ${offset} (and its divided form) rather than leaving it unchanged", () => {
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs, catchupCorrectionHours: 2 }
    expect(expandCatchupTemplate("${offset}/{offset:60}", ctx)).toBe("14400/240")
  })

  it("a negative correction shrinks ${offset} (and its divided form)", () => {
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs, catchupCorrectionHours: -0.5 }
    expect(expandCatchupTemplate("${offset}/{offset:60}", ctx)).toBe("5400/90")
  })

  it("leaves {duration} unaffected, since start and end shift by the same amount", () => {
    const withoutCorrection = { startUtcMs, stopUtcMs, nowUtcMs }
    const withCorrection = { startUtcMs, stopUtcMs, nowUtcMs, catchupCorrectionHours: 3 }
    expect(expandCatchupTemplate("{duration}", withCorrection)).toBe(
      expandCatchupTemplate("{duration}", withoutCorrection),
    )
  })

  it("shifts the {Y}-family and {utc:...} colon-format local tokens the same way as {utc}", () => {
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs, catchupCorrectionHours: 2 }
    const correctedStart = new Date(startUtcMs - 2 * 3600000)
    const expected =
      `${correctedStart.getFullYear()}${padTwo(correctedStart.getMonth() + 1)}${padTwo(correctedStart.getDate())}` +
      `${padTwo(correctedStart.getHours())}${padTwo(correctedStart.getMinutes())}${padTwo(correctedStart.getSeconds())}`
    expect(expandCatchupTemplate("{utc:YmdHMS}", ctx)).toBe(expected)
    expect(expandCatchupTemplate("{Y}{m}{d}{H}{M}{S}", ctx)).toBe(expected)
  })

  it("leaves {lutc:...} local-time colon-format raw (unaffected by correction)", () => {
    const withoutCorrection = { startUtcMs, stopUtcMs, nowUtcMs }
    const withCorrection = { startUtcMs, stopUtcMs, nowUtcMs, catchupCorrectionHours: 2 }
    expect(expandCatchupTemplate("{lutc:YmdHMS}", withCorrection)).toBe(
      expandCatchupTemplate("{lutc:YmdHMS}", withoutCorrection),
    )
  })
})

describe("buildM3uCatchupUrl: catchup-correction asymmetry (offset grows, abs-start shrinks)", () => {
  const startUtcMs = 1699999200 * 1000
  const stopUtcMs = 1700002800 * 1000
  const nowUtcMs = 1700006400 * 1000
  const baseCtx = { startUtcMs, stopUtcMs, nowUtcMs }

  it("shift mode: a positive correction moves utc earlier and leaves lutc unchanged", () => {
    const channel: CatchupCapableChannel = { url: "http://host/live.m3u8", catchup: "shift" }
    expect(buildM3uCatchupUrl(channel, { ...baseCtx, catchupCorrectionHours: 2 })).toBe(
      "http://host/live.m3u8?utc=1699992000&lutc=1700006400",
    )
  })

  it("flussonic relative (index.m3u8): a positive correction grows the offset, reaching further back", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host.example/12345/index.m3u8",
      catchup: "flussonic-hls",
    }
    expect(buildM3uCatchupUrl(channel, baseCtx)).toBe(
      "http://host.example/12345/timeshift_rel-7200.m3u8",
    )
    expect(buildM3uCatchupUrl(channel, { ...baseCtx, catchupCorrectionHours: 2 })).toBe(
      "http://host.example/12345/timeshift_rel-14400.m3u8",
    )
  })

  it("flussonic absolute (mpegts): a positive correction shrinks the absolute start timestamp", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host.example/12345/mpegts",
      catchup: "flussonic-ts",
    }
    expect(buildM3uCatchupUrl(channel, baseCtx)).toBe(
      "http://host.example/12345/timeshift_abs-1699999200.ts",
    )
    expect(buildM3uCatchupUrl(channel, { ...baseCtx, catchupCorrectionHours: 2 })).toBe(
      "http://host.example/12345/timeshift_abs-1699992000.ts",
    )
  })
})

describe("expandCatchupTemplate: {catchup-id}", () => {
  const startUtcMs = Date.UTC(2024, 0, 1, 0, 0, 0)
  const stopUtcMs = startUtcMs + 3600000
  const nowUtcMs = startUtcMs + 7200000

  it("replaces every occurrence when ctx has a catchupId", () => {
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs, catchupId: "vod-42" }
    expect(expandCatchupTemplate("{catchup-id}/{catchup-id}", ctx)).toBe("vod-42/vod-42")
  })

  it("leaves the token untouched when catchupId is absent", () => {
    const ctx = { startUtcMs, stopUtcMs, nowUtcMs }
    expect(expandCatchupTemplate("{catchup-id}", ctx)).toBe("{catchup-id}")
  })
})

describe("buildM3uCatchupUrl: flussonic stage-1/stage-2 parity (Kodi vectors)", () => {
  const startUtcMs = 1699999200 * 1000
  const stopUtcMs = 1700002800 * 1000
  const nowUtcMs = 1700006400 * 1000
  const ctx = { startUtcMs, stopUtcMs, nowUtcMs }

  it("stage 1: index.m3u8 with a query -> timeshift_rel", () => {
    const channel: CatchupCapableChannel = {
      url: "http://list.tv:8888/325/index.m3u8?token=secret",
      catchup: "flussonic",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://list.tv:8888/325/timeshift_rel-7200.m3u8?token=secret",
    )
  })

  it("stage 1: a named list (mono.m3u8) with a query -> <list>-timeshift_rel", () => {
    const channel: CatchupCapableChannel = {
      url: "http://list.tv:8888/325/mono.m3u8?token=secret",
      catchup: "flussonic",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://list.tv:8888/325/mono-timeshift_rel-7200.m3u8?token=secret",
    )
  })

  it("stage 1: literal mpegts overrides the tag's hls flavor -> timeshift_abs", () => {
    const channel: CatchupCapableChannel = {
      url: "http://ch01.spr24.net/151/mpegts?token=my_token",
      catchup: "flussonic-ts",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://ch01.spr24.net/151/timeshift_abs-1699999200.ts?token=my_token",
    )
  })

  it("stage 2: a generic URL with no recognizable extension falls back to the fs tag -> timeshift_abs", () => {
    const channel: CatchupCapableChannel = {
      url: "http://list.tv:8888/325/live?token=x",
      catchup: "fs",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://list.tv:8888/325/timeshift_abs-1699999200.ts?token=x",
    )
  })

  it("stage 2: the same generic URL under the flussonic tag -> timeshift_rel", () => {
    const channel: CatchupCapableChannel = {
      url: "http://list.tv:8888/325/live?token=x",
      catchup: "flussonic",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://list.tv:8888/325/timeshift_rel-7200.m3u8?token=x",
    )
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

  // Stage 1 is decided purely by the URL's literal extension - the fs/flussonic-ts tag
  // only takes over at stage 2 (the generic fallback), so a well-formed .m3u8 URL still
  // produces the HLS relative form even under the "fs" tag.
  it("stage 1 ignores the tag and follows the URL's own extension, even for the fs alias", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host.example/12345/index.m3u8",
      catchup: "fs",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://host.example/12345/timeshift_rel-7200.m3u8",
    )
  })

  it("builds a flussonic URL when the query string carries no '=' (valueless query)", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host.example/12345/index.m3u8?debug",
      catchup: "flussonic-hls",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe(
      "http://host.example/12345/timeshift_rel-7200.m3u8?debug",
    )
  })

  it("returns null for a flussonic URL with no second path segment to split", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host.example/onlyonesegment",
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

  it("returns null in vod mode without a source or a catchupId", () => {
    const channel: CatchupCapableChannel = { url: "http://host/live.m3u8", catchup: "vod" }
    expect(buildM3uCatchupUrl(channel, ctx)).toBeNull()
  })

  it("falls back to the bare {catchup-id} template in vod mode without a source", () => {
    const channel: CatchupCapableChannel = { url: "http://host/live.m3u8", catchup: "vod" }
    expect(buildM3uCatchupUrl(channel, { ...ctx, catchupId: "plugin://vod/episode1" })).toBe(
      "plugin://vod/episode1",
    )
  })

  it("substitutes {catchup-id} wherever it appears in an explicit catchup-source", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host/live.m3u8",
      catchup: "append",
      catchupSource: "?id={catchup-id}&again={catchup-id}",
    }
    expect(buildM3uCatchupUrl(channel, { ...ctx, catchupId: "42" })).toBe(
      "http://host/live.m3u8?id=42&again=42",
    )
  })

  it("returns null for xc mode (caller builds the Xtream URL)", () => {
    const channel: CatchupCapableChannel = { url: "http://host/live.m3u8", catchup: "xc" }
    expect(buildM3uCatchupUrl(channel, ctx)).toBeNull()
  })

  it("concatenates literally when the append source starts with & and the URL has no query (no smart '?' substitution)", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host/live.m3u8",
      catchup: "append",
      catchupSource: "&utc={utc}",
    }
    expect(buildM3uCatchupUrl(channel, ctx)).toBe("http://host/live.m3u8&utc=1704067200")
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

describe("templateHasEndToken", () => {
  it("recognizes the {utcend} family", () => {
    expect(templateHasEndToken("{utcend}")).toBe(true)
    expect(templateHasEndToken("{utcend:Y-m-d}")).toBe(true)
  })

  it("recognizes the ${end} family", () => {
    expect(templateHasEndToken("${end}")).toBe(true)
  })

  it("recognizes the {duration} family", () => {
    expect(templateHasEndToken("{duration}")).toBe(true)
    expect(templateHasEndToken("{duration:60}")).toBe(true)
  })

  it("recognizes the TiviMate/diyp ${(e)...} end marker", () => {
    expect(templateHasEndToken("${(e)yyyyMMddHHmmss}")).toBe(true)
  })

  it("returns false for start/now-only templates and an empty string", () => {
    expect(templateHasEndToken("{utc}")).toBe(false)
    expect(templateHasEndToken("${start}")).toBe(false)
    expect(templateHasEndToken("{lutc}")).toBe(false)
    expect(templateHasEndToken("")).toBe(false)
  })
})

describe("templateUsesPlayseek", () => {
  it("recognizes a ?playseek= query parameter", () => {
    expect(templateUsesPlayseek("?playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}")).toBe(true)
  })

  it("recognizes a &tvdr= query parameter, case-insensitively", () => {
    expect(templateUsesPlayseek("http://host/live?token=abc&TVDR=${(b)yyyyMMddHHmmss}")).toBe(true)
  })

  it("recognizes playseek as the sole query parameter with no leading separator", () => {
    expect(templateUsesPlayseek("playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}")).toBe(true)
  })

  it("returns false for a plain ${(b)}/${(e)} template with no playseek/tvdr parameter", () => {
    expect(templateUsesPlayseek("${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}")).toBe(false)
  })

  it("returns false for a {utc}-only template", () => {
    expect(templateUsesPlayseek("http://host/archive?utc={utc}&lutc={lutc}")).toBe(false)
  })
})

describe("streamProfileFor", () => {
  it("classifies xc mode as a terminating minute-granularity Xtream mount", () => {
    expect(streamProfileFor({ catchup: "xc" })).toEqual({ granularitySeconds: 60, terminates: true })
  })

  it("classifies the flussonic family as non-terminating second-granularity", () => {
    expect(streamProfileFor({ catchup: "flussonic" })).toEqual({ granularitySeconds: 1, terminates: false })
    expect(streamProfileFor({ catchup: "flussonic-hls" })).toEqual({ granularitySeconds: 1, terminates: false })
    expect(streamProfileFor({ catchup: "flussonic-ts" })).toEqual({ granularitySeconds: 1, terminates: false })
    expect(streamProfileFor({ catchup: "fs" })).toEqual({ granularitySeconds: 1, terminates: false })
  })

  it("classifies vod mode as a terminating second-granularity stream", () => {
    expect(streamProfileFor({ catchup: "vod" })).toEqual({ granularitySeconds: 1, terminates: true })
  })

  it("classifies append mode with a ${(e)} playseek source as non-terminating (server follows live)", () => {
    expect(
      streamProfileFor({ catchup: "append", catchupSource: "?playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}" }),
    ).toEqual({ granularitySeconds: 1, terminates: false })
  })

  it("classifies the same ${(e)} end-token source as terminating once tvdr/playseek is absent", () => {
    expect(
      streamProfileFor({ catchup: "append", catchupSource: "?seek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}" }),
    ).toEqual({ granularitySeconds: 1, terminates: true })
  })

  it("classifies append mode with no source as non-terminating", () => {
    expect(streamProfileFor({ catchup: "append" })).toEqual({ granularitySeconds: 1, terminates: false })
  })

  it("classifies a default-mode channel with a utc-only source as non-terminating", () => {
    expect(streamProfileFor({ catchup: "default", catchupSource: "http://host/archive?utc={utc}" })).toEqual({
      granularitySeconds: 1,
      terminates: false,
    })
  })

  it("classifies a shift channel as non-terminating even with an end-token catchupSource, since buildM3uCatchupUrl ignores catchupSource for shift mode", () => {
    const channel: CatchupCapableChannel = {
      url: "http://host/live.m3u8",
      catchup: "shift",
      catchupSource: "http://host/archive?utc={utc}&end={utcend}",
    }
    expect(streamProfileFor(channel)).toEqual({ granularitySeconds: 1, terminates: false })

    const ctx = {
      startUtcMs: Date.UTC(2024, 0, 1, 0, 0, 0),
      stopUtcMs: Date.UTC(2024, 0, 1, 1, 0, 0),
      nowUtcMs: Date.UTC(2024, 0, 1, 2, 0, 0),
    }
    const url = buildM3uCatchupUrl(channel, ctx)
    expect(url).not.toBeNull()
    expect(url).not.toMatch(/end=/)
  })
})

describe("XTREAM_STREAM_PROFILE", () => {
  it("is a terminating minute-granularity profile", () => {
    expect(XTREAM_STREAM_PROFILE).toEqual({ granularitySeconds: 60, terminates: true })
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
