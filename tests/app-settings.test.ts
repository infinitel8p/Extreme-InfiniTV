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

const sessionStorageStore = new Map<string, string>()
const sessionStorageMock: Storage = {
  getItem: (key) => (sessionStorageStore.has(key) ? sessionStorageStore.get(key)! : null),
  setItem: (key, value) => {
    sessionStorageStore.set(key, String(value))
  },
  removeItem: (key) => {
    sessionStorageStore.delete(key)
  },
  clear: () => {
    sessionStorageStore.clear()
  },
  key: (index) => Array.from(sessionStorageStore.keys())[index] ?? null,
  get length() {
    return sessionStorageStore.size
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
  vi.stubGlobal("sessionStorage", sessionStorageMock)
  localStorageStore.clear()
  sessionStorageStore.clear()
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

describe("content language", () => {
  it("defaults to auto (empty string)", async () => {
    const { getContentLanguage } = await import("@/scripts/lib/app-settings.js")
    expect(getContentLanguage()).toBe("")
  })

  it("set then get round-trips a known tag", async () => {
    const { getContentLanguage, setContentLanguage } = await import("@/scripts/lib/app-settings.js")
    setContentLanguage("de")
    expect(getContentLanguage()).toBe("DE")
  })

  it("rejects an unknown tag and stores auto instead", async () => {
    const { getContentLanguage, setContentLanguage } = await import("@/scripts/lib/app-settings.js")
    setContentLanguage("XX")
    expect(getContentLanguage()).toBe("")
    expect(localStorage.getItem("xt_content_lang")).toBe(null)
  })

  it("self-heals a bogus value poisoned into localStorage", async () => {
    localStorage.setItem("xt_content_lang", "not-a-tag")
    const { getContentLanguage } = await import("@/scripts/lib/app-settings.js")
    expect(getContentLanguage()).toBe("")
  })

  it("fires CONTENT_LANGUAGE_EVENT on document with the correct detail.value", async () => {
    const { CONTENT_LANGUAGE_EVENT, setContentLanguage } = await import("@/scripts/lib/app-settings.js")
    const received: string[] = []
    const listener = (event: Event) => {
      received.push((event as CustomEvent).detail.value)
    }
    document.addEventListener(CONTENT_LANGUAGE_EVENT, listener)
    try {
      setContentLanguage("fr")
      setContentLanguage("")
    } finally {
      document.removeEventListener(CONTENT_LANGUAGE_EVENT, listener)
    }
    expect(received).toEqual(["FR", ""])
  })
})

describe("resolveAccentRoll (pure)", () => {
  it("reuses a cached roll when it's still a valid preset", async () => {
    const { resolveAccentRoll } = await import("@/scripts/lib/app-settings.js")
    expect(resolveAccentRoll("cyan", ["fuchsia", "cyan", "blue"])).toBe("cyan")
  })

  it("rolls a new pick from the presets when there's no cached roll", async () => {
    const { resolveAccentRoll } = await import("@/scripts/lib/app-settings.js")
    const presets = ["fuchsia", "cyan", "blue"]
    expect(presets).toContain(resolveAccentRoll("", presets))
  })

  it("rerolls when the cached value isn't a known preset", async () => {
    const { resolveAccentRoll } = await import("@/scripts/lib/app-settings.js")
    const presets = ["fuchsia", "cyan", "blue"]
    expect(presets).toContain(resolveAccentRoll("not-a-real-color", presets))
  })
})

describe("accent (random sentinel)", () => {
  it("getAccent accepts the random sentinel as a valid stored value", async () => {
    const { getAccent, setAccent, ACCENT_RANDOM_ID } = await import("@/scripts/lib/app-settings.js")
    setAccent(ACCENT_RANDOM_ID)
    expect(getAccent()).toBe(ACCENT_RANDOM_ID)
  })

  it("setAccent applies a resolved preset to data-accent, never the literal 'random'", async () => {
    const { setAccent, ACCENT_PRESETS, ACCENT_RANDOM_ID, resolveAccentForDisplay } =
      await import("@/scripts/lib/app-settings.js")
    setAccent(ACCENT_RANDOM_ID)
    expect(ACCENT_PRESETS).toContain(resolveAccentForDisplay(ACCENT_RANDOM_ID))
    expect(document.documentElement.getAttribute("data-accent")).not.toBe(ACCENT_RANDOM_ID)
  })

  it("resolveAccentForDisplay caches the roll across calls within the same session", async () => {
    const { setAccent, resolveAccentForDisplay, ACCENT_RANDOM_ID } = await import("@/scripts/lib/app-settings.js")
    setAccent(ACCENT_RANDOM_ID)
    const firstRoll = resolveAccentForDisplay(ACCENT_RANDOM_ID)
    const secondRoll = resolveAccentForDisplay(ACCENT_RANDOM_ID)
    expect(secondRoll).toBe(firstRoll)
  })

  it("resolveAccentForDisplay passes non-random values through unchanged", async () => {
    const { resolveAccentForDisplay } = await import("@/scripts/lib/app-settings.js")
    expect(resolveAccentForDisplay("cyan")).toBe("cyan")
  })

  it("clearAccentRoll clears the cache so the next resolve rerolls", async () => {
    const { resolveAccentForDisplay, clearAccentRoll, ACCENT_RANDOM_ID } = await import("@/scripts/lib/app-settings.js")
    resolveAccentForDisplay(ACCENT_RANDOM_ID)
    expect(sessionStorage.getItem("xt_accent_roll")).not.toBeNull()
    clearAccentRoll()
    expect(sessionStorage.getItem("xt_accent_roll")).toBeNull()
  })

  it("falls back to fuchsia for a bogus stored accent value", async () => {
    localStorage.setItem("xt_accent", "not-a-real-color")
    const { getAccent } = await import("@/scripts/lib/app-settings.js")
    expect(getAccent()).toBe("fuchsia")
  })
})

describe("language grouping", () => {
  it("defaults to enabled", async () => {
    const { getLanguageGroupingEnabled } = await import("@/scripts/lib/app-settings.js")
    expect(getLanguageGroupingEnabled()).toBe(true)
  })

  it("set then get round-trips disabled", async () => {
    const { getLanguageGroupingEnabled, setLanguageGroupingEnabled } = await import("@/scripts/lib/app-settings.js")
    setLanguageGroupingEnabled(false)
    expect(getLanguageGroupingEnabled()).toBe(false)
  })

  it("set then get round-trips enabled", async () => {
    const { getLanguageGroupingEnabled, setLanguageGroupingEnabled } = await import("@/scripts/lib/app-settings.js")
    setLanguageGroupingEnabled(false)
    setLanguageGroupingEnabled(true)
    expect(getLanguageGroupingEnabled()).toBe(true)
  })

  it("stores '1' in localStorage when enabled", async () => {
    const { setLanguageGroupingEnabled } = await import("@/scripts/lib/app-settings.js")
    setLanguageGroupingEnabled(true)
    expect(localStorage.getItem("xt_lang_grouping")).toBe("1")
  })

  it("fires LANGUAGE_GROUPING_EVENT on document with the correct detail.value", async () => {
    const { LANGUAGE_GROUPING_EVENT, setLanguageGroupingEnabled } = await import("@/scripts/lib/app-settings.js")
    const received: boolean[] = []
    const listener = (event: Event) => {
      received.push((event as CustomEvent).detail.value)
    }
    document.addEventListener(LANGUAGE_GROUPING_EVENT, listener)
    try {
      setLanguageGroupingEnabled(false)
      setLanguageGroupingEnabled(true)
    } finally {
      document.removeEventListener(LANGUAGE_GROUPING_EVENT, listener)
    }
    expect(received).toEqual([false, true])
  })
})

describe("TMDb / TVDB enrichment toggles", () => {
  it("TMDb defaults to enabled (unset means on)", async () => {
    const { getTmdbEnabled } = await import("@/scripts/lib/app-settings.js")
    expect(getTmdbEnabled()).toBe(true)
  })

  it("TMDb stores nothing when explicitly enabled", async () => {
    const { setTmdbEnabled } = await import("@/scripts/lib/app-settings.js")
    setTmdbEnabled(true)
    expect(localStorage.getItem("xt_tmdb_enabled")).toBe(null)
  })

  it("TMDb writes an explicit off flag", async () => {
    const { getTmdbEnabled, setTmdbEnabled } = await import("@/scripts/lib/app-settings.js")
    setTmdbEnabled(false)
    expect(localStorage.getItem("xt_tmdb_enabled")).toBe("0")
    expect(getTmdbEnabled()).toBe(false)
  })

  it("TVDB defaults to enabled (unset means on)", async () => {
    const { getTvdbEnabled } = await import("@/scripts/lib/app-settings.js")
    expect(getTvdbEnabled()).toBe(true)
  })

  it("TVDB writes an explicit off flag", async () => {
    const { getTvdbEnabled, setTvdbEnabled } = await import("@/scripts/lib/app-settings.js")
    setTvdbEnabled(false)
    expect(localStorage.getItem("xt_tvdb_enabled")).toBe("0")
    expect(getTvdbEnabled()).toBe(false)
  })

  it("setTvdbEnabled fires TMDB_SETTINGS_EVENT with a tvdbEnabled key", async () => {
    const { TMDB_SETTINGS_EVENT, setTvdbEnabled } = await import("@/scripts/lib/app-settings.js")
    const received: Array<{ key: string; value: boolean }> = []
    const listener = (event: Event) => {
      received.push((event as CustomEvent).detail)
    }
    document.addEventListener(TMDB_SETTINGS_EVENT, listener)
    try {
      setTvdbEnabled(false)
    } finally {
      document.removeEventListener(TMDB_SETTINGS_EVENT, listener)
    }
    expect(received).toEqual([{ key: "tvdbEnabled", value: false }])
  })

  it("isTmdbActive requires both the toggle and a key", async () => {
    const { isTmdbActive, setTmdbEnabled, setTmdbApiKey } = await import("@/scripts/lib/app-settings.js")
    expect(isTmdbActive()).toBe(false)
    setTmdbApiKey("abc123")
    expect(isTmdbActive()).toBe(true)
    setTmdbEnabled(false)
    expect(isTmdbActive()).toBe(false)
  })

  it("isEnrichmentActive is true when only TVDB is on", async () => {
    const { isEnrichmentActive } = await import("@/scripts/lib/app-settings.js")
    expect(isEnrichmentActive()).toBe(true)
  })

  it("isEnrichmentActive is true when TVDB is off but TMDb is active", async () => {
    const { isEnrichmentActive, setTvdbEnabled, setTmdbApiKey } = await import("@/scripts/lib/app-settings.js")
    setTvdbEnabled(false)
    setTmdbApiKey("abc123")
    expect(isEnrichmentActive()).toBe(true)
  })

  it("isEnrichmentActive is false when both sources are off", async () => {
    const { isEnrichmentActive, setTvdbEnabled } = await import("@/scripts/lib/app-settings.js")
    setTvdbEnabled(false)
    expect(isEnrichmentActive()).toBe(false)
  })
})

describe("TMDb enabled legacy migration", () => {
  it("migrates a legacy off value (empty string) with a stored key to explicit off", async () => {
    localStorage.setItem("xt_tmdb_enabled", "")
    localStorage.setItem("xt_tmdb_key", "abc123")
    const { getTmdbEnabled } = await import("@/scripts/lib/app-settings.js")
    expect(getTmdbEnabled()).toBe(false)
    expect(localStorage.getItem("xt_tmdb_enabled")).toBe("0")
    expect(localStorage.getItem("xt_tmdb_enabled_v2")).toBe("1")
  })

  it("migrates a legacy on value (\"1\") to the new on representation", async () => {
    localStorage.setItem("xt_tmdb_enabled", "1")
    const { getTmdbEnabled } = await import("@/scripts/lib/app-settings.js")
    expect(getTmdbEnabled()).toBe(true)
    expect(localStorage.getItem("xt_tmdb_enabled")).toBe("")
  })

  it("leaves a legacy off value alone when no key is stored", async () => {
    localStorage.setItem("xt_tmdb_enabled", "")
    const { getTmdbEnabled } = await import("@/scripts/lib/app-settings.js")
    expect(getTmdbEnabled()).toBe(true)
  })

  it("does not re-run once the marker is set, even across a fresh module load", async () => {
    localStorage.setItem("xt_tmdb_enabled", "")
    localStorage.setItem("xt_tmdb_key", "abc123")
    const first = await import("@/scripts/lib/app-settings.js")
    expect(first.getTmdbEnabled()).toBe(false)

    vi.resetModules()
    const second = await import("@/scripts/lib/app-settings.js")
    expect(second.getTmdbEnabled()).toBe(false)
  })

  it("leaves a 1.9-beta explicit enable alone (last seen version >= 1.9.0)", async () => {
    localStorage.setItem("xt_last_seen_version", "1.9.0-beta.3")
    localStorage.setItem("xt_tmdb_enabled", "")
    localStorage.setItem("xt_tmdb_key", "abc123")
    const { getTmdbEnabled } = await import("@/scripts/lib/app-settings.js")
    expect(getTmdbEnabled()).toBe(true)
    expect(localStorage.getItem("xt_tmdb_enabled")).toBe("")
    expect(localStorage.getItem("xt_tmdb_enabled_v2")).toBe("1")
  })
})
