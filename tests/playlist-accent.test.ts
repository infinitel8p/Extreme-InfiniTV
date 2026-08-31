/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

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
const sessionStorageMock = makeMemoryStorage()

beforeEach(() => {
  vi.stubGlobal("localStorage", localStorageMock)
  vi.stubGlobal("sessionStorage", sessionStorageMock)
  localStorageMock.clear()
  sessionStorageMock.clear()
  document.documentElement.removeAttribute("data-accent")
})

afterEach(() => {
  vi.unstubAllGlobals()
})

let activeEntry: { accent?: string } | null = null
let globalAccent = "fuchsia"

vi.mock("@/scripts/lib/creds.js", () => ({
  getActiveEntry: async () => activeEntry,
}))

vi.mock("@/scripts/lib/app-settings.js", () => {
  const presets = ["fuchsia", "rose", "ember", "emerald", "cyan", "blue", "violet"]
  return {
    ACCENT_PRESETS: presets,
    ACCENT_EVENT: "xt:accent-changed",
    getAccent: () => globalAccent,
    resolveAccentForDisplay: (accentId: string) => {
      if (accentId !== "random") return accentId
      const cached = sessionStorage.getItem("xt_accent_roll") || ""
      const roll = presets.includes(cached) ? cached : presets[1]
      sessionStorage.setItem("xt_accent_roll", roll)
      return roll
    },
  }
})

const PRESETS = ["fuchsia", "rose", "ember", "emerald", "cyan", "blue", "violet"]

import { resolveEffectiveAccent, applyEffectiveAccent } from "@/scripts/lib/playlist-accent.ts"

describe("resolveEffectiveAccent (pure)", () => {
  it("prefers a valid per-playlist override over the global accent", () => {
    expect(resolveEffectiveAccent("cyan", "fuchsia")).toBe("cyan")
  })

  it("falls back to the global accent when the override isn't a known preset", () => {
    expect(resolveEffectiveAccent("not-a-real-color", "blue")).toBe("blue")
  })

  it("falls back to the global accent when there's no override at all", () => {
    expect(resolveEffectiveAccent(undefined, "blue")).toBe("blue")
    expect(resolveEffectiveAccent("", "blue")).toBe("blue")
  })
})

describe("applyEffectiveAccent", () => {
  beforeEach(() => {
    activeEntry = null
    globalAccent = "fuchsia"
  })

  it("applies the active playlist's override and caches it", async () => {
    activeEntry = { accent: "emerald" }
    globalAccent = "blue"
    await applyEffectiveAccent()
    expect(document.documentElement.getAttribute("data-accent")).toBe("emerald")
    expect(localStorage.getItem("xt_accent_active")).toBe("emerald")
  })

  it("falls back to the global accent and clears the cache when there's no override", async () => {
    activeEntry = { }
    globalAccent = "blue"
    await applyEffectiveAccent()
    expect(document.documentElement.getAttribute("data-accent")).toBe("blue")
    expect(localStorage.getItem("xt_accent_active")).toBeNull()
  })

  it("ignores an invalid override and falls back to the global accent", async () => {
    activeEntry = { accent: "not-a-real-color" }
    globalAccent = "cyan"
    await applyEffectiveAccent()
    expect(document.documentElement.getAttribute("data-accent")).toBe("cyan")
    expect(localStorage.getItem("xt_accent_active")).toBeNull()
  })

  it("removes data-accent entirely when the effective accent is fuchsia (the default)", async () => {
    document.documentElement.setAttribute("data-accent", "blue")
    activeEntry = null
    globalAccent = "fuchsia"
    await applyEffectiveAccent()
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false)
  })

  it("lets an explicit fuchsia override win over a non-default global accent", async () => {
    activeEntry = { accent: "fuchsia" }
    globalAccent = "blue"
    await applyEffectiveAccent()
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false)
    expect(localStorage.getItem("xt_accent_active")).toBe("fuchsia")
  })

  it("never writes to xt_accent, only to the active-override cache", async () => {
    activeEntry = { accent: "violet" }
    globalAccent = "fuchsia"
    await applyEffectiveAccent()
    expect(localStorage.getItem("xt_accent")).toBeNull()
  })

  it("resolves a random global accent to a rolled preset, not the literal id", async () => {
    activeEntry = null
    globalAccent = "random"
    await applyEffectiveAccent()
    expect(PRESETS).toContain(document.documentElement.getAttribute("data-accent"))
  })

  it("lets a valid per-playlist override win over a random global accent", async () => {
    activeEntry = { accent: "cyan" }
    globalAccent = "random"
    await applyEffectiveAccent()
    expect(document.documentElement.getAttribute("data-accent")).toBe("cyan")
  })
})
