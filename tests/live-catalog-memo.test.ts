import { describe, expect, it, vi } from "vitest"

vi.mock("@/scripts/lib/cache.js", () => ({ getCached: () => null }))
vi.mock("@/scripts/lib/preferences.js", () => ({
  getChannelOverrides: () => ({}),
  getChannelOverridesRevision: () => 1,
  ensureLoaded: async () => {},
}))

import { applyLiveOverrides } from "@/scripts/lib/live-catalog.ts"

describe("applyLiveOverrides memo", () => {
  it("keeps visible and includeHidden results identity-stable side by side", () => {
    const rows = [{ id: "1", name: "One", url: "http://x/1" }]
    const visible = applyLiveOverrides(rows, "pl", true)
    const all = applyLiveOverrides(rows, "pl", true, { includeHidden: true })
    expect(applyLiveOverrides(rows, "pl", true)).toBe(visible)
    expect(applyLiveOverrides(rows, "pl", true, { includeHidden: true })).toBe(all)
  })
})
