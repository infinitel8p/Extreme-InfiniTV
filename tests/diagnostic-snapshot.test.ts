import { describe, it, expect } from "vitest"
import {
  buildSessionSnapshot,
  type SessionSnapshotInputs,
} from "../src/scripts/lib/diagnostic-snapshot"

// Baseline inputs representing every field resolved successfully; individual
// tests override only what they care about.
const BASE_INPUTS: SessionSnapshotInputs = {
  appVersion: "1.8.0",
  updateChannel: "stable",
  storeBuild: false,
  isTauri: true,
  isWindows: true,
  isMacOS: false,
  isAndroid: false,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  language: "en-US",
  screenWidth: 1920,
  screenHeight: 1080,
  devicePixelRatio: 1,
  hevcSupported: true,
  clearKeySupported: true,
  mseAvailable: true,
  audioTranscodeAvailable: true,
  vodAudioRemuxAvailable: true,
  customFfmpegPathConfigured: false,
  playerBackend: "videojs",
  perfMode: false,
  perfModeAuto: false,
  tvDevice: null,
  networkTimeoutSeconds: 20,
  audioTranscodeAuto: true,
  customUserAgentConfigured: false,
  locale: "en",
  playlistCount: 2,
  activePlaylistEntry: {
    type: "xtream",
    mirrors: [{ serverUrl: "http://mirror.test", username: "bob", password: "hunter2" }],
    liveContainer: "ts",
  },
}

describe("buildSessionSnapshot", () => {
  it("builds a Windows Tauri desktop snapshot", () => {
    const snapshot = buildSessionSnapshot(BASE_INPUTS)
    expect(snapshot.platform).toBe("windows")
    expect(snapshot.isTauri).toBe(true)
    expect(snapshot.storeBuild).toBe(false)
    expect(snapshot.activePlaylistType).toBe("xtream")
    expect(snapshot.activePlaylistMirrorsConfigured).toBe(true)
    expect(snapshot.activePlaylistLiveContainer).toBe("ts")
  })

  it("builds a macOS snapshot", () => {
    const snapshot = buildSessionSnapshot({
      ...BASE_INPUTS,
      isWindows: false,
      isMacOS: true,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      activePlaylistEntry: { type: "m3u" },
    })
    expect(snapshot.platform).toBe("macos")
    expect(snapshot.activePlaylistType).toBe("m3u")
    // Mirrors/liveContainer are xtream-only fields; a non-xtream entry never surfaces them.
    expect(snapshot.activePlaylistMirrorsConfigured).toBeNull()
    expect(snapshot.activePlaylistLiveContainer).toBeNull()
  })

  it("builds a web (non-Tauri) snapshot regardless of host OS", () => {
    const snapshot = buildSessionSnapshot({
      ...BASE_INPUTS,
      isTauri: false,
      isWindows: true,
      storeBuild: null,
      audioTranscodeAvailable: null,
      vodAudioRemuxAvailable: null,
      activePlaylistEntry: null,
    })
    expect(snapshot.platform).toBe("web")
    expect(snapshot.activePlaylistType).toBeNull()
    expect(snapshot.activePlaylistMirrorsConfigured).toBeNull()
  })

  it("never throws and keeps a stable shape when every probe failed (nulls)", () => {
    const allNullInputs: SessionSnapshotInputs = {
      appVersion: null,
      updateChannel: null,
      storeBuild: null,
      isTauri: null,
      isWindows: null,
      isMacOS: null,
      isAndroid: null,
      userAgent: null,
      language: null,
      screenWidth: null,
      screenHeight: null,
      devicePixelRatio: null,
      hevcSupported: null,
      clearKeySupported: null,
      mseAvailable: null,
      audioTranscodeAvailable: null,
      vodAudioRemuxAvailable: null,
      customFfmpegPathConfigured: null,
      playerBackend: null,
      perfMode: null,
      perfModeAuto: null,
      tvDevice: null,
      networkTimeoutSeconds: null,
      audioTranscodeAuto: null,
      customUserAgentConfigured: null,
      locale: null,
      playlistCount: null,
      activePlaylistEntry: null,
    }
    let snapshot: ReturnType<typeof buildSessionSnapshot> | null = null
    expect(() => {
      snapshot = buildSessionSnapshot(allNullInputs)
    }).not.toThrow()
    expect(snapshot).not.toBeNull()
    // Falls back to "web" instead of throwing or emitting an undefined platform.
    expect(snapshot!.platform).toBe("web")
    expect(Object.keys(snapshot!).sort()).toEqual(
      Object.keys(buildSessionSnapshot(BASE_INPUTS)).sort(),
    )
  })

  it("never leaks host/username/password from the active playlist entry", () => {
    const snapshot = buildSessionSnapshot({
      ...BASE_INPUTS,
      activePlaylistEntry: {
        type: "xtream",
        serverUrl: "http://provider.tld:8080",
        username: "alice",
        password: "supersecret",
        mirrors: [
          { serverUrl: "http://mirror.tld", username: "alice2", password: "supersecret2" },
        ],
        liveContainer: "m3u8",
      },
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain("provider.tld")
    expect(serialized).not.toContain("mirror.tld")
    expect(serialized).not.toContain("alice")
    expect(serialized).not.toContain("supersecret")
    // The only xtream fields that do surface are the boolean/enum shape, not the values above.
    expect(snapshot.activePlaylistMirrorsConfigured).toBe(true)
    expect(snapshot.activePlaylistLiveContainer).toBe("m3u8")
  })
})
