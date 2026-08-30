import { describe, it, expect } from "vitest"
import { classifyEffectTier } from "../src/scripts/tv/motion"

const ANDROID_TV_UA = "Mozilla/5.0 (Linux; Android 11; Philips) AppleWebKit/537.36"
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
const ARMV7_UA = "Mozilla/5.0 (Linux; armv7l) AppleWebKit/537.36"

describe("classifyEffectTier", () => {
  it("defaults to full when nothing suggests a weak device", () => {
    expect(classifyEffectTier({ deviceMemoryGb: 8, hardwareConcurrency: 8, userAgent: DESKTOP_UA })).toBe("full")
  })

  it("goes lite when device memory is 2GB or less", () => {
    expect(classifyEffectTier({ deviceMemoryGb: 2, hardwareConcurrency: 8, userAgent: DESKTOP_UA })).toBe("lite")
    expect(classifyEffectTier({ deviceMemoryGb: 1.38, hardwareConcurrency: 8, userAgent: DESKTOP_UA })).toBe("lite")
  })

  it("keeps full above the memory threshold", () => {
    expect(classifyEffectTier({ deviceMemoryGb: 4, hardwareConcurrency: 8, userAgent: DESKTOP_UA })).toBe("full")
  })

  it("goes lite for low-core Android, but not low-core desktop", () => {
    expect(classifyEffectTier({ deviceMemoryGb: 4, hardwareConcurrency: 4, userAgent: ANDROID_TV_UA })).toBe("lite")
    expect(classifyEffectTier({ deviceMemoryGb: 4, hardwareConcurrency: 4, userAgent: DESKTOP_UA })).toBe("full")
  })

  it("keeps full for higher-core Android", () => {
    expect(classifyEffectTier({ deviceMemoryGb: 4, hardwareConcurrency: 6, userAgent: ANDROID_TV_UA })).toBe("full")
  })

  it("goes lite for an armv7/armeabi user agent regardless of memory or cores", () => {
    expect(classifyEffectTier({ deviceMemoryGb: 8, hardwareConcurrency: 8, userAgent: ARMV7_UA })).toBe("lite")
  })

  it("lets a forced tier win over every other signal", () => {
    expect(classifyEffectTier({ deviceMemoryGb: 1, hardwareConcurrency: 2, userAgent: ARMV7_UA, forced: "full" })).toBe(
      "full"
    )
    expect(classifyEffectTier({ deviceMemoryGb: 8, hardwareConcurrency: 8, userAgent: DESKTOP_UA, forced: "lite" })).toBe(
      "lite"
    )
  })

  it("treats missing signals as full", () => {
    expect(classifyEffectTier({})).toBe("full")
  })
})
