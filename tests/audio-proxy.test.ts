import { describe, it, expect } from "vitest"
import { peekAudioTranscodeAvailable } from "../src/scripts/lib/audio-proxy"

describe("peekAudioTranscodeAvailable", () => {
  it("returns synchronously without forcing a probe outside a Tauri desktop context", () => {
    expect(peekAudioTranscodeAvailable()).toBe(false)
  })
})
