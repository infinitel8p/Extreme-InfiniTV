/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest"
import { isSafeAudioSourceUrl } from "../src/scripts/lib/audio-effects"

describe("isSafeAudioSourceUrl", () => {
  const origin = window.location.origin
  const otherPort = window.location.port === "9999" ? "8080" : "9999"
  const differentPortOrigin = `${window.location.protocol}//${window.location.hostname}:${otherPort}`

  it("treats blob: URLs as safe regardless of origin", () => {
    expect(isSafeAudioSourceUrl("blob:http://localhost/1234-5678")).toBe(true)
    expect(isSafeAudioSourceUrl("blob:https://other.example/abcd")).toBe(true)
  })

  it("treats a same-origin absolute URL as safe", () => {
    expect(isSafeAudioSourceUrl(`${origin}/stream.m3u8`)).toBe(true)
  })

  it("treats a same-origin relative URL as safe", () => {
    expect(isSafeAudioSourceUrl("/stream.m3u8")).toBe(true)
    expect(isSafeAudioSourceUrl("stream.m3u8")).toBe(true)
  })

  it("treats a cross-origin http URL as unsafe", () => {
    expect(isSafeAudioSourceUrl("http://provider.example/stream.m3u8")).toBe(false)
  })

  it("treats a cross-origin https URL as unsafe", () => {
    expect(isSafeAudioSourceUrl("https://provider.example/stream.m3u8")).toBe(false)
  })

  it("treats a same-origin URL on a different port as unsafe", () => {
    expect(isSafeAudioSourceUrl(`${differentPortOrigin}/stream.m3u8`)).toBe(false)
  })

  it("treats data: URLs as unsafe", () => {
    expect(isSafeAudioSourceUrl("data:video/mp4;base64,AAAA")).toBe(false)
  })

  it("treats an empty string as unsafe", () => {
    expect(isSafeAudioSourceUrl("")).toBe(false)
  })

  it("treats a malformed URL string as unsafe", () => {
    expect(isSafeAudioSourceUrl("http://")).toBe(false)
  })
})
