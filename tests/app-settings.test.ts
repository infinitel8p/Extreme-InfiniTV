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

describe("dev mode", () => {
  it("defaults to false", async () => {
    const { getDevModeEnabled } = await import("@/scripts/lib/app-settings.js")
    expect(getDevModeEnabled()).toBe(false)
  })

  it("set true then get returns true", async () => {
    const { getDevModeEnabled, setDevModeEnabled } = await import("@/scripts/lib/app-settings.js")
    setDevModeEnabled(true)
    expect(getDevModeEnabled()).toBe(true)
  })

  it("set false clears it", async () => {
    const { getDevModeEnabled, setDevModeEnabled } = await import("@/scripts/lib/app-settings.js")
    setDevModeEnabled(true)
    setDevModeEnabled(false)
    expect(getDevModeEnabled()).toBe(false)
  })

  it("fires DEV_MODE_EVENT on document with the correct detail.value in both directions", async () => {
    const { DEV_MODE_EVENT, setDevModeEnabled } = await import("@/scripts/lib/app-settings.js")
    const received: boolean[] = []
    const listener = (event: Event) => {
      received.push((event as CustomEvent).detail.value)
    }
    document.addEventListener(DEV_MODE_EVENT, listener)
    try {
      setDevModeEnabled(true)
      setDevModeEnabled(false)
    } finally {
      document.removeEventListener(DEV_MODE_EVENT, listener)
    }
    expect(received).toEqual([true, false])
  })
})

describe("density", () => {
  it("defaults to cozy", async () => {
    const { getDensity } = await import("@/scripts/lib/app-settings.js")
    expect(getDensity()).toBe("cozy")
  })

  it("falls back to cozy for a bogus stored value", async () => {
    localStorage.setItem("xt_density", "spacious")
    const { getDensity } = await import("@/scripts/lib/app-settings.js")
    expect(getDensity()).toBe("cozy")
  })

  it("set compact writes localStorage and sets --xt-density and data-density on documentElement", async () => {
    const { setDensity } = await import("@/scripts/lib/app-settings.js")
    setDensity("compact")
    expect(localStorage.getItem("xt_density")).toBe("compact")
    expect(document.documentElement.style.getPropertyValue("--xt-density")).toBe("0.75")
    expect(document.documentElement.getAttribute("data-density")).toBe("compact")
  })

  it("set cozy removes the key, the attribute, and the inline var", async () => {
    const { setDensity } = await import("@/scripts/lib/app-settings.js")
    setDensity("compact")
    setDensity("cozy")
    expect(localStorage.getItem("xt_density")).toBe(null)
    expect(document.documentElement.style.getPropertyValue("--xt-density")).toBe("")
    expect(document.documentElement.hasAttribute("data-density")).toBe(false)
  })

  it("getDensityFactor returns the numeric factor for each preset", async () => {
    const { setDensity, getDensityFactor } = await import("@/scripts/lib/app-settings.js")
    setDensity("compact")
    expect(getDensityFactor()).toBe(0.75)
    setDensity("cozy")
    expect(getDensityFactor()).toBe(1)
    setDensity("comfortable")
    expect(getDensityFactor()).toBe(1.3)
  })
})
