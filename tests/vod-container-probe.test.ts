import { describe, it, expect, beforeEach, vi } from "vitest"

const providerFetchMock = vi.fn()
vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: (...args: unknown[]) => providerFetchMock(...args),
}))

vi.mock("@/scripts/lib/log.js", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() },
  redactUrl: (input: unknown) => String(input),
}))

import {
  classifyContainerBytes,
  classifySourceHealth,
  swapUrlExtension,
  probeVodContainerAlternative,
  clearVodContainerProbeCache,
} from "../src/scripts/lib/vod-container-probe"

describe("classifyContainerBytes", () => {
  it("recognizes an MKV/EBML header", () => {
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88, 0, 0, 0, 0])
    expect(classifyContainerBytes(bytes)).toBe("mkv")
  })

  it("recognizes an MP4 ftyp box", () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ])
    expect(classifyContainerBytes(bytes)).toBe("mp4")
  })

  it("recognizes an AVI RIFF header", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20,
    ])
    expect(classifyContainerBytes(bytes)).toBe("avi")
  })

  it("recognizes an MPEG-TS sync byte", () => {
    const bytes = new Uint8Array([0x47, 0x40, 0x00, 0x10, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(classifyContainerBytes(bytes)).toBe("ts")
  })

  it("returns null for garbage bytes", () => {
    const bytes = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb])
    expect(classifyContainerBytes(bytes)).toBeNull()
  })

  it("returns null for an empty array", () => {
    expect(classifyContainerBytes(new Uint8Array())).toBeNull()
  })

  it("returns null for a too-short array", () => {
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00])
    expect(classifyContainerBytes(bytes)).toBeNull()
  })
})

describe("classifySourceHealth", () => {
  it("returns unreachable for a non-ok response", () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    expect(classifySourceHealth(false, bytes)).toBe("unreachable")
  })

  it("returns unreachable for an ok response with null bytes", () => {
    expect(classifySourceHealth(true, null)).toBe("unreachable")
  })

  it("returns media for an ok response with MP4 magic bytes", () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    expect(classifySourceHealth(true, bytes)).toBe("media")
  })

  it("returns not-media for an ok response with HTML-looking bytes", () => {
    const bytes = new TextEncoder().encode("<html><body>error")
    expect(classifySourceHealth(true, bytes)).toBe("not-media")
  })
})

describe("swapUrlExtension", () => {
  it("replaces the extension on the last path segment", () => {
    expect(swapUrlExtension("http://h/series/u/p/514689.avi", "mp4")).toBe(
      "http://h/series/u/p/514689.mp4",
    )
  })

  it("preserves a query string", () => {
    expect(swapUrlExtension("http://h/series/u/p/514689.avi?token=abc&expires=1", "mkv")).toBe(
      "http://h/series/u/p/514689.mkv?token=abc&expires=1",
    )
  })

  it("returns null when the last path segment has no extension", () => {
    expect(swapUrlExtension("http://h/series/u/p/514689", "mp4")).toBeNull()
  })
})

const MKV_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88, 0, 0, 0, 0])
const MP4_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
const AVI_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20])

function mockStreamedResponse(
  chunks: Uint8Array[],
  opts: { ok?: boolean; status?: number } = {},
): { response: unknown; cancel: ReturnType<typeof vi.fn> } {
  let nextChunkIndex = 0
  const cancel = vi.fn(async () => {})
  const response = {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body: {
      getReader() {
        return {
          read: async () => {
            if (nextChunkIndex >= chunks.length) return { done: true, value: undefined }
            const value = chunks[nextChunkIndex]
            nextChunkIndex += 1
            return { done: false, value }
          },
          cancel,
        }
      },
    },
  }
  return { response, cancel }
}

describe("probeVodContainerAlternative", () => {
  beforeEach(() => {
    providerFetchMock.mockReset()
    clearVodContainerProbeCache()
  })

  it("returns the original URL when it is mislabeled (real bytes arrive split across two chunks)", async () => {
    const originalUrl = "http://h/series/u/p/mislabeled.avi"
    const { response } = mockStreamedResponse([MKV_BYTES.slice(0, 4), MKV_BYTES.slice(4)])
    providerFetchMock.mockResolvedValueOnce(response)

    const result = await probeVodContainerAlternative(originalUrl)

    expect(result).toEqual({ url: originalUrl, container: "mkv" })
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
    expect(providerFetchMock.mock.calls[0][0]).toBe(originalUrl)
  })

  it("returns the .mp4 sibling when the original is genuinely avi but a working .mp4 exists", async () => {
    const originalUrl = "http://h/series/u/p/514689.avi"
    const mp4Url = "http://h/series/u/p/514689.mp4"
    const mkvUrl = "http://h/series/u/p/514689.mkv"
    providerFetchMock.mockImplementation(async (url: string) => {
      if (url === originalUrl) return mockStreamedResponse([AVI_BYTES]).response
      if (url === mp4Url) return mockStreamedResponse([MP4_BYTES]).response
      if (url === mkvUrl) return mockStreamedResponse([MKV_BYTES]).response
      throw new Error(`unexpected URL: ${url}`)
    })

    const result = await probeVodContainerAlternative(originalUrl)

    expect(result).toEqual({ url: mp4Url, container: "mp4" })
    expect(providerFetchMock).toHaveBeenCalledTimes(2)
    expect(providerFetchMock.mock.calls.map((call) => call[0])).toEqual([originalUrl, mp4Url])
  })

  it("treats an empty 200 OK body as a miss, not a success, for every candidate", async () => {
    const originalUrl = "http://h/series/u/p/empty.avi"
    const mp4Url = "http://h/series/u/p/empty.mp4"
    const mkvUrl = "http://h/series/u/p/empty.mkv"
    providerFetchMock.mockImplementation(async (url: string) => {
      if (url === originalUrl) return mockStreamedResponse([AVI_BYTES]).response
      if (url === mp4Url) return mockStreamedResponse([], { ok: true, status: 200 }).response
      if (url === mkvUrl) return mockStreamedResponse([], { ok: true, status: 200 }).response
      throw new Error(`unexpected URL: ${url}`)
    })

    const result = await probeVodContainerAlternative(originalUrl)

    expect(result).toBeNull()
    expect(providerFetchMock).toHaveBeenCalledTimes(3)
  })

  it("caches the result so a second call for the same URL never touches the network again", async () => {
    const originalUrl = "http://h/series/u/p/cached.avi"
    const mp4Url = "http://h/series/u/p/cached.mp4"
    const mkvUrl = "http://h/series/u/p/cached.mkv"
    providerFetchMock.mockImplementation(async (url: string) => {
      if (url === originalUrl) return mockStreamedResponse([AVI_BYTES]).response
      if (url === mp4Url) return mockStreamedResponse([MP4_BYTES]).response
      if (url === mkvUrl) return mockStreamedResponse([MKV_BYTES]).response
      throw new Error(`unexpected URL: ${url}`)
    })

    const first = await probeVodContainerAlternative(originalUrl)
    const callsAfterFirst = providerFetchMock.mock.calls.length
    const second = await probeVodContainerAlternative(originalUrl)

    expect(second).toEqual(first)
    expect(providerFetchMock).toHaveBeenCalledTimes(callsAfterFirst)
  })
})
