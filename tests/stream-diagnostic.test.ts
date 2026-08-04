import { describe, expect, it } from "vitest"
import { isMixedContentBlocked } from "../src/scripts/lib/stream-diagnostic.js"

describe("isMixedContentBlocked", () => {
  it("does not flag http streams inside the Tauri app, even in a secure context", () => {
    expect(isMixedContentBlocked(true, true, "http://provider.example/live/1.m3u8")).toBe(false)
  })

  it("flags http streams in the real web deployment when the page is secure", () => {
    expect(isMixedContentBlocked(false, true, "http://provider.example/live/1.m3u8")).toBe(true)
  })

  it("does not flag http streams when the web page itself isn't a secure context", () => {
    expect(isMixedContentBlocked(false, false, "http://provider.example/live/1.m3u8")).toBe(false)
  })

  it("never flags https streams", () => {
    expect(isMixedContentBlocked(false, true, "https://provider.example/live/1.m3u8")).toBe(false)
    expect(isMixedContentBlocked(true, true, "https://provider.example/live/1.m3u8")).toBe(false)
  })
})
