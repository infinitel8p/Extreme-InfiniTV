import { describe, expect, it } from "vitest"
import { clampReceiverVolume, mapNativeErrorCode } from "../src/scripts/receiver/engines"

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

  it("maps IO/network/timeout codes to the network message", () => {
    expect(mapNativeErrorCode("ERROR_CODE_IO_NETWORK_CONNECTION_FAILED")).toBe("receiver.error.network")
    expect(mapNativeErrorCode("ERROR_CODE_IO_BAD_HTTP_STATUS")).toBe("receiver.error.network")
    expect(mapNativeErrorCode("ERROR_CODE_TIMEOUT")).toBe("receiver.error.network")
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
