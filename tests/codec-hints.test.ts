import { describe, expect, it } from "vitest"
import { hasHevcNameHint } from "../src/scripts/lib/codec-hints"

describe("hasHevcNameHint", () => {
  it("matches common HEVC tags in channel names", () => {
    expect(hasHevcNameHint("Sky Documentaries -HD (Local) ''hevc h.265''")).toBe(true)
    expect(hasHevcNameHint("BBC One FHD HEVC")).toBe(true)
    expect(hasHevcNameHint("Canal+ Sport H.265")).toBe(true)
    expect(hasHevcNameHint("Discovery H265")).toBe(true)
    expect(hasHevcNameHint("TLC [x265]")).toBe(true)
    expect(hasHevcNameHint("RTL h 265")).toBe(true)
    expect(hasHevcNameHint("ZDF HVEC")).toBe(true)
    expect(hasHevcNameHint("arte (HEVC)")).toBe(true)
  })

  it("ignores names without an HEVC tag", () => {
    expect(hasHevcNameHint("BBC One FHD")).toBe(false)
    expect(hasHevcNameHint("Channel 265")).toBe(false)
    expect(hasHevcNameHint("US (MLS 046)")).toBe(false)
    expect(hasHevcNameHint("Hever Castle TV")).toBe(false)
    expect(hasHevcNameHint("")).toBe(false)
    expect(hasHevcNameHint(null)).toBe(false)
    expect(hasHevcNameHint(undefined)).toBe(false)
  })
})
