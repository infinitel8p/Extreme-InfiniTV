/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { isSafeAudioSourceUrl, bindMonoAudioMpv } from "../src/scripts/lib/audio-effects"
import { setMonoAudioEnabled } from "../src/scripts/lib/app-settings.js"

// Node 24+ ships an experimental native `localStorage` (undefined without
// --localstorage-file) that shadows jsdom's; stub it with a real in-memory Storage.
const localStorageStore = new Map<string, string>()
const localStorageMock: Storage = {
  getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key)! : null),
  setItem: (key, value) => {
    localStorageStore.set(key, String(value))
  },
  removeItem: (key) => {
    localStorageStore.delete(key)
  },
  clear: () => {
    localStorageStore.clear()
  },
  key: (index) => Array.from(localStorageStore.keys())[index] ?? null,
  get length() {
    return localStorageStore.size
  },
}

beforeAll(() => {
  vi.stubGlobal("localStorage", localStorageMock)
})

describe("isSafeAudioSourceUrl", () => {
  const origin = window.location.origin
  const otherPort = window.location.port === "9999" ? "8080" : "9999"
  const differentPortOrigin = `${window.location.protocol}//${window.location.hostname}:${otherPort}`

  it("treats blob: URLs as safe regardless of origin", () => {
    expect(isSafeAudioSourceUrl("blob:http://localhost/1234-5678")).toBe(true)
    expect(isSafeAudioSourceUrl("blob:https://other.example/abcd")).toBe(true)
  })

  it("treats a same-origin absolute URL as safe", () => {
    expect(isSafeAudioSourceUrl(`${origin}/stream.m3u8`)).toBe(true)
  })

  it("treats a same-origin relative URL as safe", () => {
    expect(isSafeAudioSourceUrl("/stream.m3u8")).toBe(true)
    expect(isSafeAudioSourceUrl("stream.m3u8")).toBe(true)
  })

  it("treats a cross-origin http URL as unsafe", () => {
    expect(isSafeAudioSourceUrl("http://provider.example/stream.m3u8")).toBe(false)
  })

  it("treats a cross-origin https URL as unsafe", () => {
    expect(isSafeAudioSourceUrl("https://provider.example/stream.m3u8")).toBe(false)
  })

  it("treats a same-origin URL on a different port as unsafe", () => {
    expect(isSafeAudioSourceUrl(`${differentPortOrigin}/stream.m3u8`)).toBe(false)
  })

  it("treats data: URLs as unsafe", () => {
    expect(isSafeAudioSourceUrl("data:video/mp4;base64,AAAA")).toBe(false)
  })

  it("treats an empty string as unsafe", () => {
    expect(isSafeAudioSourceUrl("")).toBe(false)
  })

  it("treats a malformed URL string as unsafe", () => {
    expect(isSafeAudioSourceUrl("http://")).toBe(false)
  })
})

describe("bindMonoAudioMpv", () => {
  function makeHandle(setProperty?: (name: string, value: unknown) => Promise<void>) {
    const listeners = new Map<string, () => void>()
    return {
      handle: {
        on: (event: string, fn: () => void) => listeners.set(event, fn),
        setProperty,
      },
      fire: (event: string) => listeners.get(event)?.(),
    }
  }

  afterEach(() => {
    setMonoAudioEnabled(false)
  })

  it("sets the mono pan filter via the handle when the setting is on at loadedmetadata", () => {
    const setProperty = vi.fn<(name: string, value: unknown) => Promise<void>>().mockResolvedValue(undefined)
    setMonoAudioEnabled(true)

    const { handle, fire } = makeHandle(setProperty)
    bindMonoAudioMpv(handle)
    fire("loadedmetadata")

    expect(setProperty).toHaveBeenCalledWith("af", expect.stringContaining("pan=stereo"))
  })

  it("clears the filter when the setting is off", () => {
    const setProperty = vi.fn<(name: string, value: unknown) => Promise<void>>().mockResolvedValue(undefined)
    setMonoAudioEnabled(false)

    const { handle, fire } = makeHandle(setProperty)
    bindMonoAudioMpv(handle)
    fire("playing")

    expect(setProperty).toHaveBeenCalledWith("af", "")
  })

  it("reapplies on a mono-audio setting change and stops after dispose", () => {
    const setProperty = vi.fn<(name: string, value: unknown) => Promise<void>>().mockResolvedValue(undefined)
    const { handle } = makeHandle(setProperty)
    const dispose = bindMonoAudioMpv(handle)

    setMonoAudioEnabled(true)
    expect(setProperty).toHaveBeenCalledWith("af", expect.stringContaining("pan=stereo"))

    dispose()
    setProperty.mockClear()
    setMonoAudioEnabled(false)
    expect(setProperty).not.toHaveBeenCalled()
  })

  it("is a no-op when the handle has no setProperty", () => {
    const { handle, fire } = makeHandle()
    expect(() => {
      bindMonoAudioMpv(handle)
      fire("loadedmetadata")
    }).not.toThrow()
  })
})
