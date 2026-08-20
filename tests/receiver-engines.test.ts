import { describe, expect, it } from "vitest"
import { mapNativeErrorCode } from "../src/scripts/receiver/engines"

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
