import { describe, expect, it } from "vitest"
import {
  clampReceiverVolume,
  durationSecondsFromMs,
  mapNativeErrorCode,
  normalizeReportedDuration,
  normalizeReportedVolume,
} from "../src/scripts/receiver/engines"
import { httpStatusFromErrorDetail, isConnectionLimitStatus } from "../src/scripts/lib/codec-hints"

describe("mapNativeErrorCode", () => {
  it("maps decoder/decoding/DRM codes to the video codec message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_DECODING_FAILED")).toBe("receiver.error.videoCodec")
    expect(mapNativeErrorCode("ERROR_CODE_DECODER_INIT_FAILED")).toBe("receiver.error.videoCodec")
    expect(mapNativeErrorCode("ERROR_CODE_DRM_SYSTEM_ERROR")).toBe("receiver.error.videoCodec")
  })

  it("maps audio track codes to the audio codec message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_AUDIO_TRACK_INIT_FAILED")).toBe("receiver.error.audioCodec")
  })

  it("maps parsing/container/unsupported codes to the container message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_PARSING_CONTAINER_MALFORMED")).toBe("receiver.error.container")
    expect(mapNativeErrorCode("SOURCE_UNSUPPORTED")).toBe("receiver.error.container")
  })

  it("maps IO/network codes to the network message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_IO_NETWORK_CONNECTION_FAILED")).toBe("receiver.error.network")
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS")).toBe("receiver.error.network")
  })

  it("maps timeout codes to the timeout message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_TIMEOUT")).toBe("receiver.error.timeout")
  })

  it("prefers the connection-limit message when the provider refused the request", () => {
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", 458)).toBe("receiver.error.connectionLimit")
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", 509)).toBe("receiver.error.connectionLimit")
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", 429)).toBe("receiver.error.connectionLimit")
    expect(mapNativeErrorCode(null, 458)).toBe("receiver.error.connectionLimit")
  })

  it("leaves unrelated HTTP failures on the network message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", 404)).toBe("receiver.error.network")
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", 500)).toBe("receiver.error.network")
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS", null)).toBe("receiver.error.network")
  })

  it("falls back to the generic title for unknown or missing codes", () => {
    expect(mapNativeErrorCode("ERROR_CODE_REMOTE_ERROR")).toBe("receiver.error.title")
    expect(mapNativeErrorCode(null)).toBe("receiver.error.title")
    expect(mapNativeErrorCode(undefined)).toBe("receiver.error.title")
    expect(mapNativeErrorCode("")).toBe("receiver.error.title")
  })
})

describe("clampReceiverVolume", () => {
  it("passes through values already within [0, 1]", () => {
    expect(clampReceiverVolume(0)).toBe(0)
    expect(clampReceiverVolume(0.4)).toBe(0.4)
    expect(clampReceiverVolume(1)).toBe(1)
  })

  it("clamps out-of-range values to the nearest bound", () => {
    expect(clampReceiverVolume(-0.5)).toBe(0)
    expect(clampReceiverVolume(1.5)).toBe(1)
  })

  it("treats non-finite input as silence", () => {
    expect(clampReceiverVolume(Number.NaN)).toBe(0)
    expect(clampReceiverVolume(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampReceiverVolume(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe("isConnectionLimitStatus", () => {
  it("recognizes the statuses panels use to refuse an extra stream", () => {
    expect(isConnectionLimitStatus(458)).toBe(true)
    expect(isConnectionLimitStatus(429)).toBe(true)
    expect(isConnectionLimitStatus(509)).toBe(true)
  })

  it("rejects other statuses and missing input", () => {
    expect(isConnectionLimitStatus(200)).toBe(false)
    expect(isConnectionLimitStatus(403)).toBe(false)
    expect(isConnectionLimitStatus(null)).toBe(false)
    expect(isConnectionLimitStatus(undefined)).toBe(false)
  })
})

describe("httpStatusFromErrorDetail", () => {
  it("reads the status our hls.js path appends", () => {
    expect(httpStatusFromErrorDetail("manifestLoadError (HTTP 458)")).toBe(458)
  })

  it("reads the status out of a shaka BAD_HTTP_STATUS payload", () => {
    expect(
      httpStatusFromErrorDetail('shaka:network:1001 ["http://host/live/u/p/1.m3u8",458,"",{},1]')
    ).toBe(458)
  })

  it("returns null when no status is present", () => {
    expect(httpStatusFromErrorDetail("bufferStalledError")).toBe(null)
    expect(httpStatusFromErrorDetail("")).toBe(null)
    expect(httpStatusFromErrorDetail(null)).toBe(null)
  })
})

describe("normalizeReportedDuration", () => {
  it("passes through a finite positive duration", () => {
    expect(normalizeReportedDuration(5400)).toBe(5400)
    expect(normalizeReportedDuration(0.5)).toBe(0.5)
  })

  it("drops the values a player reports before it knows the timeline", () => {
    expect(normalizeReportedDuration(0)).toBeUndefined()
    expect(normalizeReportedDuration(-1)).toBeUndefined()
    expect(normalizeReportedDuration(Number.NaN)).toBeUndefined()
    expect(normalizeReportedDuration(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(normalizeReportedDuration(null)).toBeUndefined()
    expect(normalizeReportedDuration(undefined)).toBeUndefined()
  })
})

describe("durationSecondsFromMs", () => {
  it("converts a known native duration to whole seconds", () => {
    expect(durationSecondsFromMs(5400000)).toBe(5400)
    expect(durationSecondsFromMs(1500)).toBe(1)
  })

  it("drops a missing or unset native duration instead of reporting zero", () => {
    expect(durationSecondsFromMs(0)).toBeUndefined()
    expect(durationSecondsFromMs(Number.MIN_SAFE_INTEGER)).toBeUndefined()
    expect(durationSecondsFromMs(Number.NaN)).toBeUndefined()
    expect(durationSecondsFromMs(undefined)).toBeUndefined()
  })
})

describe("normalizeReportedVolume", () => {
  it("passes through a real level, including silence", () => {
    expect(normalizeReportedVolume(0)).toBe(0)
    expect(normalizeReportedVolume(0.35)).toBe(0.35)
    expect(normalizeReportedVolume(1)).toBe(1)
  })

  it("treats an out-of-range or missing level as no volume surface at all", () => {
    expect(normalizeReportedVolume(-0.1)).toBeUndefined()
    expect(normalizeReportedVolume(1.5)).toBeUndefined()
    expect(normalizeReportedVolume(Number.NaN)).toBeUndefined()
    expect(normalizeReportedVolume(null)).toBeUndefined()
    expect(normalizeReportedVolume(undefined)).toBeUndefined()
  })
})
