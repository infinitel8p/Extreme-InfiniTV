/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

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

function setUserAgent(userAgent: string) {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => userAgent,
  })
}

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
const MACOS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal("localStorage", localStorageMock)
  localStorageStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("downloadDirMatchesPlatform", () => {
  it("rejects a Windows path on macOS", async () => {
    setUserAgent(MACOS_UA)
    const { downloadDirMatchesPlatform } = await import("@/scripts/lib/app-settings.js")
    expect(downloadDirMatchesPlatform("C:\\Users\\Ludo\\Downloads")).toBe(false)
  })

  it("accepts a POSIX path on macOS", async () => {
    setUserAgent(MACOS_UA)
    const { downloadDirMatchesPlatform } = await import("@/scripts/lib/app-settings.js")
    expect(downloadDirMatchesPlatform("/Users/ludo/Downloads")).toBe(true)
  })

  it("rejects a POSIX path on Windows", async () => {
    setUserAgent(WINDOWS_UA)
    const { downloadDirMatchesPlatform } = await import("@/scripts/lib/app-settings.js")
    expect(downloadDirMatchesPlatform("/Users/ludo/Downloads")).toBe(false)
  })

  it("accepts a Windows drive path on Windows", async () => {
    setUserAgent(WINDOWS_UA)
    const { downloadDirMatchesPlatform } = await import("@/scripts/lib/app-settings.js")
    expect(downloadDirMatchesPlatform("C:\\Users\\Ludo\\Downloads")).toBe(true)
  })

  it("accepts a Windows UNC path on Windows", async () => {
    setUserAgent(WINDOWS_UA)
    const { downloadDirMatchesPlatform } = await import("@/scripts/lib/app-settings.js")
    expect(downloadDirMatchesPlatform("\\\\nas\\share\\downloads")).toBe(true)
  })

  it("leaves an empty string alone regardless of platform", async () => {
    setUserAgent(MACOS_UA)
    const { downloadDirMatchesPlatform } = await import("@/scripts/lib/app-settings.js")
    expect(downloadDirMatchesPlatform("")).toBe(true)
  })

  it("leaves an Android content:// URI alone regardless of platform", async () => {
    setUserAgent(MACOS_UA)
    const { downloadDirMatchesPlatform } = await import("@/scripts/lib/app-settings.js")
    expect(downloadDirMatchesPlatform("content://com.android.externalstorage/tree/foo")).toBe(true)
  })
})

describe("getDownloadDir", () => {
  it("self-heals a Windows path poisoned into localStorage on macOS", async () => {
    setUserAgent(MACOS_UA)
    localStorage.setItem("xt_download_dir", "C:\\Users\\Ludo\\Downloads")
    const { getDownloadDir } = await import("@/scripts/lib/app-settings.js")
    expect(getDownloadDir()).toBe("")
  })

  it("keeps a POSIX path on macOS", async () => {
    setUserAgent(MACOS_UA)
    localStorage.setItem("xt_download_dir", "/Users/ludo/Downloads")
    const { getDownloadDir } = await import("@/scripts/lib/app-settings.js")
    expect(getDownloadDir()).toBe("/Users/ludo/Downloads")
  })
})
