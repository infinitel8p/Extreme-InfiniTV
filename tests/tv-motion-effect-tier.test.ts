/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest"
import { effectTier, resetEffectTierCache, heavyBlurClass } from "../src/scripts/tv/motion"

// Node 24+ ships an experimental native `localStorage` that shadows jsdom's; stub a
// real in-memory Storage so every test in this file sees one consistent store.
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

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, configurable: true })
  localStorageStore.clear()
  document.documentElement.removeAttribute("data-tv-effects")
  resetEffectTierCache()
})

describe("effectTier / resetEffectTierCache", () => {
  it("honors the xt_tv_effects override and stamps data-tv-effects inside the TV shell", () => {
    document.documentElement.dataset.tv = "1"
    localStorage.setItem("xt_tv_effects", "lite")
    resetEffectTierCache()
    expect(effectTier()).toBe("lite")
    expect(document.documentElement.dataset.tvEffects).toBe("lite")
    delete document.documentElement.dataset.tv
  })

  it("does not stamp data-tv-effects outside the TV shell", () => {
    delete document.documentElement.dataset.tv
    localStorage.setItem("xt_tv_effects", "lite")
    resetEffectTierCache()
    expect(effectTier()).toBe("lite")
    expect(document.documentElement.dataset.tvEffects).toBeUndefined()
  })

  it("re-reads the override after resetEffectTierCache(), not just at first call", () => {
    localStorage.setItem("xt_tv_effects", "full")
    resetEffectTierCache()
    expect(effectTier()).toBe("full")

    localStorage.setItem("xt_tv_effects", "lite")
    resetEffectTierCache()
    expect(effectTier()).toBe("lite")

    localStorage.removeItem("xt_tv_effects")
    resetEffectTierCache()
    expect(effectTier()).toBe("full")
  })

  it("stays memoized across calls until reset", () => {
    localStorage.setItem("xt_tv_effects", "full")
    resetEffectTierCache()
    expect(effectTier()).toBe("full")

    // No reset here: the override change alone must not move an already-memoized tier.
    localStorage.setItem("xt_tv_effects", "lite")
    expect(effectTier()).toBe("full")
  })
})

describe("heavyBlurClass", () => {
  it("tags the heavy blur classes with tv-heavy-blur on the full tier", () => {
    localStorage.setItem("xt_tv_effects", "full")
    resetEffectTierCache()
    expect(heavyBlurClass("blur-xl object-cover", "bg-surface-2")).toBe("tv-heavy-blur blur-xl object-cover")
  })

  it("returns the flat classes on the lite tier", () => {
    localStorage.setItem("xt_tv_effects", "lite")
    resetEffectTierCache()
    expect(heavyBlurClass("blur-xl object-cover", "bg-surface-2")).toBe("bg-surface-2")
  })
})
