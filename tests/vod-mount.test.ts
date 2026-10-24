import { describe, it, expect } from "vitest"
import { shouldWriteProgress } from "../src/scripts/lib/vod-mount"

describe("shouldWriteProgress", () => {
  it("skips the write while a remux switch is recovering", () => {
    expect(shouldWriteProgress(99, true)).toBe(false)
  })

  it("writes near the end when not recovering, and skips the first second", () => {
    expect(shouldWriteProgress(96, false)).toBe(true)
    expect(shouldWriteProgress(0.5, false)).toBe(false)
  })
})
