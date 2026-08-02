import { describe, it, expect } from "vitest"
import { stepChannelIndex, channelKeyDirection } from "../src/scripts/lib/channel-step"

describe("stepChannelIndex", () => {
  it("returns null for an empty list", () => {
    expect(stepChannelIndex(-1, 0, 1)).toBeNull()
    expect(stepChannelIndex(2, 0, -1)).toBeNull()
  })

  it("starts at the first channel when nothing is playing and stepping forward", () => {
    expect(stepChannelIndex(-1, 5, 1)).toBe(0)
  })

  it("starts at the last channel when nothing is playing and stepping backward", () => {
    expect(stepChannelIndex(-1, 5, -1)).toBe(4)
  })

  it("steps forward to the next index", () => {
    expect(stepChannelIndex(2, 5, 1)).toBe(3)
  })

  it("steps backward to the previous index", () => {
    expect(stepChannelIndex(2, 5, -1)).toBe(1)
  })

  it("wraps from the last index to the first when stepping forward", () => {
    expect(stepChannelIndex(4, 5, 1)).toBe(0)
  })

  it("wraps from the first index to the last when stepping backward", () => {
    expect(stepChannelIndex(0, 5, -1)).toBe(4)
  })

  it("recovers from a current index out of range by wrapping it into bounds", () => {
    expect(stepChannelIndex(7, 5, 1)).toBe(3)
    expect(stepChannelIndex(-3, 5, 1)).toBe(0)
  })

  it("handles a multi-step delta with wrap-around in both directions", () => {
    expect(stepChannelIndex(2, 5, 3)).toBe(0)
    expect(stepChannelIndex(1, 5, -3)).toBe(3)
  })
})

describe("channelKeyDirection", () => {
  it("maps the spec-named channel keys", () => {
    expect(channelKeyDirection("ChannelUp", 0)).toBe(1)
    expect(channelKeyDirection("ChannelDown", 0)).toBe(-1)
  })

  it("maps the alternate Media-prefixed spellings", () => {
    expect(channelKeyDirection("MediaChannelUp", 0)).toBe(1)
    expect(channelKeyDirection("MediaChannelDown", 0)).toBe(-1)
  })

  it("falls back to keyCode 166/167 when the key is unmapped", () => {
    expect(channelKeyDirection("Unidentified", 166)).toBe(1)
    expect(channelKeyDirection("Unidentified", 167)).toBe(-1)
    expect(channelKeyDirection("", 166)).toBe(1)
    expect(channelKeyDirection(null, 167)).toBe(-1)
    expect(channelKeyDirection(undefined, 166)).toBe(1)
  })

  it("ignores browser back/forward, which share keyCode 166/167 on Windows", () => {
    expect(channelKeyDirection("BrowserBack", 166)).toBeNull()
    expect(channelKeyDirection("BrowserForward", 167)).toBeNull()
  })

  it("lets a named channel key win over a disagreeing keyCode", () => {
    expect(channelKeyDirection("ChannelUp", 167)).toBe(1)
    expect(channelKeyDirection("ChannelDown", 166)).toBe(-1)
  })

  it("returns null for ordinary keys", () => {
    expect(channelKeyDirection("a", 65)).toBeNull()
    expect(channelKeyDirection("ArrowUp", 38)).toBeNull()
  })
})
