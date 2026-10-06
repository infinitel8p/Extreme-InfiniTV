import { describe, it, expect, vi } from "vitest"

const advanceMirror = vi.hoisted(() => vi.fn(async () => "http://mirror/next"))

vi.mock("@/scripts/lib/xtream-api.js", () => ({ advanceMirror }))
vi.mock("@/scripts/lib/log.js", () => ({
  log: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}))

import { createMirrorHopper } from "@/scripts/lib/vod-mirror-hop.ts"

describe("createMirrorHopper", () => {
  it("forwards entryId to advanceMirror", async () => {
    const onHop = vi.fn()
    const hop = createMirrorHopper({
      buildUrl: () => "http://x",
      isCurrent: () => true,
      logTag: "[test]",
      hopsUsed: 0,
      entryId: "pl-b",
      onHop,
    })
    expect(await hop({ httpStatus: 403 })).toBe(true)
    expect(advanceMirror).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ entryId: "pl-b" }))
    expect(onHop).toHaveBeenCalledWith("http://mirror/next", 1)
  })
})
