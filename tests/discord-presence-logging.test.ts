/**
 * @vitest-environment jsdom
 */
// Discord not running was logged as a WARN once per page load - once per navigation in an MPA,
// which made it ~40% of all WARN/ERROR lines in the app log.
import { describe, it, expect, beforeEach, vi } from "vitest"

const warnings: unknown[][] = []
const infos: unknown[][] = []
vi.mock("@/scripts/lib/log.js", () => ({
  log: {
    log: () => {},
    debug: () => {},
    info: (...args: unknown[]) => infos.push(args),
    warn: (...args: unknown[]) => warnings.push(args),
    error: () => {},
  },
  redactUrl: (value: unknown) => String(value),
}))

let invokeError: Error | null = null
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => {
    if (invokeError) throw invokeError
  },
}))

vi.mock("@/scripts/lib/app-settings.js", () => ({
  isDiscordEnabledForPlaylist: () => true,
  getDiscordClientId: () => "1234567890",
}))

async function loadModule() {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  Object.defineProperty(navigator, "userAgent", {
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    configurable: true,
  })
  return import("@/scripts/lib/discord-rpc.js")
}

beforeEach(() => {
  vi.resetModules()
  warnings.length = 0
  infos.length = 0
  invokeError = null
  sessionStorage.clear()
})

describe("discord presence failure logging", () => {
  const absent = [
    "Discord IPC connect failed: Couldn't connect to the Discord IPC socket",
    "Discord set_activity failed: Broken pipe (os error 32)",
    "Connection refused",
  ]

  it("records Discord being absent once per app session, not as a warning", async () => {
    for (const message of absent) {
      vi.resetModules()
      warnings.length = 0
      infos.length = 0
      sessionStorage.clear()
      invokeError = new Error(message)
      const { setRichPresence } = await loadModule()
      await setRichPresence({ playlistId: "pl-1", details: "Watching" })
      expect(warnings, message).toHaveLength(0)
      expect(infos, message).toHaveLength(1)
      expect(String(infos[0][0])).toContain("Discord is not running")
    }
  })

  it("stays quiet on a later page load in the same session", async () => {
    invokeError = new Error("Discord IPC connect failed: Couldn't connect to the Discord IPC socket")
    const first = await loadModule()
    await first.setRichPresence({ playlistId: "pl-1", details: "Watching" })
    expect(infos).toHaveLength(1)

    vi.resetModules()
    const second = await loadModule()
    await second.setRichPresence({ playlistId: "pl-1", details: "Watching" })
    expect(infos).toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })

  it("still warns about an unexpected failure", async () => {
    invokeError = new Error("invalid client id")
    const { setRichPresence } = await loadModule()
    await setRichPresence({ playlistId: "pl-1", details: "Watching" })
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0][0])).toContain("set_activity failed")
  })
})
