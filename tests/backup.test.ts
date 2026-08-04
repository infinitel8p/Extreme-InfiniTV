import { describe, it, expect, beforeEach, vi } from "vitest"

type BackupSnapshot = { localContent: Record<string, unknown> }

let credsState: any = { entries: [], selectedId: "" }
const restoredCredsState = vi.fn(async (state: any) => {
  credsState = state
})
vi.mock("@/scripts/lib/creds.js", () => ({
  getState: async () => credsState,
  restoreState: (state: any) => restoredCredsState(state),
}))

vi.mock("@/scripts/lib/preferences.js", () => ({
  ensureLoaded: async () => {},
  snapshotPrefs: () => ({}),
  restorePrefs: async () => {},
}))

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getUserAgent: () => "",
  setUserAgent: () => {},
  getDownloadDir: () => "",
  setDownloadDir: () => {},
  downloadDirMatchesPlatform: () => true,
  getDownloadConcurrency: () => 2,
  setDownloadConcurrency: () => {},
  getPlayerBackend: () => "videojs",
  setPlayerBackend: () => {},
  getPlayerPath: () => "",
  setPlayerPath: () => {},
  getPlayerExtraArgs: () => [],
  setPlayerExtraArgs: () => {},
  getPlayerReuseInstance: () => false,
  setPlayerReuseInstance: () => {},
  PLAYER_BACKENDS: ["videojs", "artplayer", "shaka", "mpv", "vlc"],
  EXTERNAL_PLAYER_BACKENDS: ["mpv", "vlc"],
}))

const localContentStore = new Map<string, string>()
vi.mock("@/scripts/lib/local-content.js", () => ({
  getLocalContent: async (entryId: string) => localContentStore.get(entryId) ?? "",
  setLocalContent: async (entryId: string, text: string) => {
    localContentStore.set(entryId, text)
    return true
  },
}))

import { exportAll, importAll } from "@/scripts/lib/backup.js"

const customDoc = JSON.stringify({
  version: 1,
  nextId: 2,
  groups: ["News"],
  channels: [
    {
      key: "abc",
      id: 1,
      group: "News",
      sources: [{ kind: "xtream", entryId: "src-1", streamId: 10 }],
      overrides: { name: null, logo: null, chno: null, tvgId: null },
      catchup: null,
    },
  ],
})

beforeEach(() => {
  localContentStore.clear()
  restoredCredsState.mockClear()
  credsState = {
    entries: [
      { _id: "src-1", type: "xtream", serverUrl: "http://host", username: "u", password: "p" },
      { _id: "loc-1", type: "local-m3u", sourceName: "list.m3u" },
      { _id: "cust-1", type: "custom" },
    ],
    selectedId: "cust-1",
  }
})

describe("exportAll", () => {
  it("includes custom-playlist docs alongside local-m3u text, keyed by entry id", async () => {
    localContentStore.set("loc-1", "#EXTM3U\n")
    localContentStore.set("cust-1", customDoc)

    const snapshot = (await exportAll()) as BackupSnapshot

    expect(Object.keys(snapshot.localContent).sort()).toEqual(["cust-1", "loc-1"])
    expect(snapshot.localContent["cust-1"]).toBe(customDoc)
    expect(snapshot.localContent["loc-1"]).toBe("#EXTM3U\n")
  })

  it("skips entry types that have no stored content", async () => {
    localContentStore.set("src-1", "should not be exported")

    const snapshot = (await exportAll()) as BackupSnapshot

    expect(snapshot.localContent["src-1"]).toBeUndefined()
  })
})

describe("importAll", () => {
  it("round-trips a custom playlist's document through export then import", async () => {
    localContentStore.set("cust-1", customDoc)
    const snapshot = await exportAll()
    localContentStore.clear()

    const summary = await importAll(snapshot)

    expect(summary.localContent).toBe(1)
    expect(localContentStore.get("cust-1")).toBe(customDoc)
    expect(restoredCredsState).toHaveBeenCalledWith({
      entries: credsState.entries,
      selectedId: "cust-1",
    })
  })

  it("imports an older backup that carries no local content at all", async () => {
    const summary = await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [{ _id: "src-1", type: "xtream" }], selectedId: "src-1" },
      prefs: {},
    })

    expect(summary.localContent).toBe(0)
    expect(summary.playlists).toBe(1)
  })

  it("rejects a blob without the format marker", async () => {
    await expect(importAll({ version: 1 })).rejects.toThrow(/format marker/)
  })
})
