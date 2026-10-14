/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import enMessages from "@/i18n/en.json"
import esMessages from "@/i18n/es.json"

// Locale JSONs carry a non-string `_meta` field, so cast through `unknown`
// (same pattern as `src/scripts/lib/i18n.ts`) rather than direct to
// `Record<string, string>`.
const en = enMessages as unknown as Record<string, string>
const es = esMessages as unknown as Record<string, string>

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

const DENSITY_KEY = "settings.density.compact"

// The refresh's dynamic import settles an unbounded number of ticks later; wait on the event, not tick counts.
function waitForLocaleEvents(
  eventName: string,
  count: number,
  timeoutMs = 5000
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const codes: string[] = []
    function listener(event: Event): void {
      codes.push((event as CustomEvent).detail.code)
      if (codes.length < count) return
      clearTimeout(timer)
      document.removeEventListener(eventName, listener)
      resolve(codes)
    }
    const timer = setTimeout(() => {
      document.removeEventListener(eventName, listener)
      reject(
        new Error(`timed out waiting for ${count} "${eventName}" events, saw ${codes.length}`)
      )
    }, timeoutMs)
    document.addEventListener(eventName, listener)
  })
}

function seedStaleSpanishCache(): void {
  // Simulate a translation blob persisted before an app update added a new
  // key: same Spanish snapshot as the bundled JSON but missing one string
  // that only shipped later.
  const staleMessages = { ...es }
  delete staleMessages[DENSITY_KEY]
  localStorage.setItem("xt_locale", "es")
  localStorage.setItem(
    "xt_locale_messages_v3",
    JSON.stringify({ code: "es", messages: staleMessages })
  )
}

function seedSpanishCacheWithVersion(appVersion: string): void {
  localStorage.setItem("xt_locale", "es")
  localStorage.setItem(
    "xt_locale_messages_v3",
    JSON.stringify({ code: "es", appVersion, messages: es })
  )
}

function setAppVersionMeta(content: string): HTMLMetaElement {
  const meta = document.createElement("meta")
  meta.setAttribute("name", "x-app-version")
  meta.setAttribute("content", content)
  document.head.appendChild(meta)
  return meta
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal("localStorage", localStorageMock)
  localStorageStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("initI18n background refresh", () => {
  it("refreshes a stale persisted locale snapshot with the bundled JSON after boot", async () => {
    seedStaleSpanishCache()

    const { initI18n, t, LOCALE_EVENT } = await import("@/scripts/lib/i18n")
    // two dispatches: initial setLocale, then the background refresh
    const refreshDispatched = waitForLocaleEvents(LOCALE_EVENT, 2)
    await initI18n()

    // Right after the initial setLocale the stale snapshot is still active,
    // so the missing key falls back to English.
    expect(t(DENSITY_KEY)).toBe(en[DENSITY_KEY])

    await refreshDispatched

    expect(t(DENSITY_KEY)).toBe(es[DENSITY_KEY])

    const persisted = JSON.parse(localStorage.getItem("xt_locale_messages_v3")!)
    expect(persisted.code).toBe("es")
    expect(persisted.messages[DENSITY_KEY]).toBe(es[DENSITY_KEY])
  })

  it("dispatches the locale-changed event again once the refresh updates the active locale", async () => {
    seedStaleSpanishCache()

    const { initI18n, LOCALE_EVENT } = await import("@/scripts/lib/i18n")
    const receivedCodes = waitForLocaleEvents(LOCALE_EVENT, 2)
    await initI18n()

    // One dispatch from the initial setLocale, one from the background
    // refresh once it finds the bundled JSON differs from the seeded snapshot.
    await expect(receivedCodes).resolves.toEqual(["es", "es"])
  })

  it("does not overwrite the active locale's cache if the user switched away before the refresh settles", async () => {
    seedStaleSpanishCache()

    const { initI18n, setLocale, t } = await import("@/scripts/lib/i18n")
    await initI18n()
    await setLocale("en")

    // no event fires here; the refresh is blocked on this same module import and its continuation queued first
    await import("@/i18n/es.json")

    expect(t(DENSITY_KEY)).toBe(en[DENSITY_KEY])
    expect(localStorage.getItem("xt_locale_messages_v3")).toBe(null)
  })

  it("skips the refresh entirely when the cached snapshot's app version stamp matches", async () => {
    const meta = setAppVersionMeta("9.9.9")
    seedSpanishCacheWithVersion("9.9.9")

    const { initI18n, LOCALE_EVENT } = await import("@/scripts/lib/i18n")
    const handler = vi.fn()
    document.addEventListener(LOCALE_EVENT, handler)
    await initI18n()
    await Promise.resolve()
    await Promise.resolve()
    document.removeEventListener(LOCALE_EVENT, handler)
    meta.remove()

    // Only the initial setLocale dispatch - the version stamp matched, so the
    // background refresh never re-fetched or re-dispatched.
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("still refreshes when the cached snapshot's app version stamp differs", async () => {
    const meta = setAppVersionMeta("9.9.9")
    seedSpanishCacheWithVersion("1.0.0")

    const { initI18n, LOCALE_EVENT } = await import("@/scripts/lib/i18n")
    const receivedCodes = waitForLocaleEvents(LOCALE_EVENT, 2)
    await initI18n()
    await expect(receivedCodes).resolves.toEqual(["es", "es"])
    meta.remove()
  })
})

describe("shouldRefreshLocaleCache", () => {
  it("refreshes when there is no seeded stamp", async () => {
    const { shouldRefreshLocaleCache } = await import("@/scripts/lib/i18n")
    expect(shouldRefreshLocaleCache(null, "1.0.0")).toBe(true)
  })

  it("refreshes when there is no current stamp to compare against", async () => {
    const { shouldRefreshLocaleCache } = await import("@/scripts/lib/i18n")
    expect(shouldRefreshLocaleCache("1.0.0", null)).toBe(true)
  })

  it("refreshes when the stamps differ", async () => {
    const { shouldRefreshLocaleCache } = await import("@/scripts/lib/i18n")
    expect(shouldRefreshLocaleCache("1.0.0", "1.1.0")).toBe(true)
  })

  it("skips the refresh when the stamps match", async () => {
    const { shouldRefreshLocaleCache } = await import("@/scripts/lib/i18n")
    expect(shouldRefreshLocaleCache("1.0.0", "1.0.0")).toBe(false)
  })
})
