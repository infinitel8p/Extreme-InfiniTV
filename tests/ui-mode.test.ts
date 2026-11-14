/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { parseUiMode, resolveUiMode, getUiMode, setUiMode, UI_MODE_KEY } from "../src/scripts/lib/ui-mode"

function makeMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value))
    },
    removeItem: (key) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  }
}

const localStorageMock = makeMemoryStorage()

beforeEach(() => {
  vi.stubGlobal("localStorage", localStorageMock)
  localStorageMock.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("parseUiMode", () => {
  it("passes through known modes", () => {
    expect(parseUiMode("tv")).toBe("tv")
    expect(parseUiMode("desktop")).toBe("desktop")
    expect(parseUiMode("auto")).toBe("auto")
  })

  it("falls back to auto for anything unknown", () => {
    expect(parseUiMode(null)).toBe("auto")
    expect(parseUiMode(undefined)).toBe("auto")
    expect(parseUiMode("")).toBe("auto")
    expect(parseUiMode("garbage")).toBe("auto")
  })
})

describe("resolveUiMode", () => {
  it("always resolves tv in kiosk mode, regardless of the stored setting", () => {
    expect(resolveUiMode({ stored: "desktop", realTv: false, detectedTv: false, appMode: "receiver" })).toBe("tv")
  })

  it("locks to tv on a real TV device, ignoring the stored setting", () => {
    expect(resolveUiMode({ stored: "desktop", realTv: true, detectedTv: false })).toBe("tv")
  })

  it("resolves tv when the stored mode is tv", () => {
    expect(resolveUiMode({ stored: "tv", realTv: false, detectedTv: false })).toBe("tv")
  })

  it("resolves classic when the stored mode is desktop", () => {
    expect(resolveUiMode({ stored: "desktop", realTv: false, detectedTv: true })).toBe("classic")
  })

  it("falls back to detection when the stored mode is auto", () => {
    expect(resolveUiMode({ stored: "auto", realTv: false, detectedTv: true })).toBe("tv")
    expect(resolveUiMode({ stored: "auto", realTv: false, detectedTv: false })).toBe("classic")
  })

  it("treats an unset stored value the same as auto", () => {
    expect(resolveUiMode({ stored: null, realTv: false, detectedTv: true })).toBe("tv")
    expect(resolveUiMode({ stored: undefined, realTv: false, detectedTv: false })).toBe("classic")
  })
})

describe("getUiMode / setUiMode", () => {
  it("defaults to auto when unset", () => {
    expect(getUiMode()).toBe("auto")
  })

  it("round-trips a stored value", () => {
    setUiMode("tv")
    expect(getUiMode()).toBe("tv")
    expect(localStorage.getItem(UI_MODE_KEY)).toBe("tv")
  })
})
