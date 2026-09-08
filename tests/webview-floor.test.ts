import { describe, it, expect } from "vitest"
import {
  MIN_CHROMIUM_MAJOR,
  parseChromiumMajor,
  isBelowChromiumFloor,
} from "../src/scripts/lib/webview-floor"
import { chromiumMajorFromUserAgent } from "../src/scripts/lib/codec-hints"

const ANDROID_WEBVIEW_83 =
  "Mozilla/5.0 (Linux; Android 9; SHIELD Android TV Build/PPR1.180610.011) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/83.0.4103.120 Mobile Safari/537.36 wv"

const MODERN_CHROME_130 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

const MODERN_EDGE_130 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68"

const IOS_CHROME_83 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/83.0.4103.88 Mobile/15E148 Safari/605.1"

const FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"

const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"

describe("parseChromiumMajor", () => {
  it("is codec-hints.ts's chromiumMajorFromUserAgent", () => {
    expect(parseChromiumMajor).toBe(chromiumMajorFromUserAgent)
  })

  it("reads the Chrome major from an old Android WebView UA", () => {
    expect(parseChromiumMajor(ANDROID_WEBVIEW_83)).toBe(83)
  })

  it("reads the Chrome major from a modern desktop Chrome UA", () => {
    expect(parseChromiumMajor(MODERN_CHROME_130)).toBe(130)
  })

  it("reads the Chrome major from an Edge UA (Edg/ still carries Chrome/NN)", () => {
    expect(parseChromiumMajor(MODERN_EDGE_130)).toBe(130)
  })

  it("reads the CriOS major from an iOS Chrome UA", () => {
    expect(parseChromiumMajor(IOS_CHROME_83)).toBe(83)
  })

  it("returns null for Firefox", () => {
    expect(parseChromiumMajor(FIREFOX_UA)).toBeNull()
  })

  it("returns null for Safari", () => {
    expect(parseChromiumMajor(SAFARI_UA)).toBeNull()
  })

  it("returns null for an empty string", () => {
    expect(parseChromiumMajor("")).toBeNull()
  })
})

describe("isBelowChromiumFloor", () => {
  it("is true for an Android WebView below the floor", () => {
    expect(isBelowChromiumFloor(ANDROID_WEBVIEW_83)).toBe(true)
  })

  it("is false for a modern Chrome above the floor", () => {
    expect(isBelowChromiumFloor(MODERN_CHROME_130)).toBe(false)
  })

  it("is false for a modern Edge above the floor", () => {
    expect(isBelowChromiumFloor(MODERN_EDGE_130)).toBe(false)
  })

  it("is false when the engine is unknown (Firefox)", () => {
    expect(isBelowChromiumFloor(FIREFOX_UA)).toBe(false)
  })

  it("is false when the engine is unknown (Safari)", () => {
    expect(isBelowChromiumFloor(SAFARI_UA)).toBe(false)
  })

  it("is false for an empty string", () => {
    expect(isBelowChromiumFloor("")).toBe(false)
  })

  it("respects a custom minimum", () => {
    expect(isBelowChromiumFloor(MODERN_CHROME_130, 131)).toBe(true)
    expect(isBelowChromiumFloor(MODERN_CHROME_130, 130)).toBe(false)
  })

  it("exposes the default floor constant", () => {
    expect(MIN_CHROMIUM_MAJOR).toBe(111)
  })
})
