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

let prefsSnapshot: Record<string, unknown> = {}
const restorePrefs = vi.fn(async (prefs: any) => {
  prefsSnapshot = prefs
})
vi.mock("@/scripts/lib/preferences.js", () => ({
  ensureLoaded: async () => {},
  snapshotPrefs: () => prefsSnapshot,
  restorePrefs: (prefs: any) => restorePrefs(prefs),
  mergePrefsSnapshots: (current: any, incoming: any, allowedIds: Set<string>) => {
    const merged = { ...(current || {}) }
    if (incoming && typeof incoming === "object") {
      for (const [playlistId, bucket] of Object.entries(incoming)) {
        if (allowedIds.has(playlistId)) merged[playlistId] = bucket
      }
    }
    return merged
  },
}))

let settingsState: any = {
  userAgent: "",
  downloadDir: "",
  downloadConcurrency: 2,
  playerBackend: "videojs",
  playerPaths: { mpv: "", vlc: "" },
  playerExtraArgs: { mpv: [] as string[], vlc: [] as string[] },
  playerReuse: { mpv: false, vlc: false },
  tmdbKey: "",
  tmdbEnabled: false,
  tvdbEnabled: true,
  perfMode: false,
  accent: "fuchsia",
  density: "cozy",
  hubStripIds: ["continue-watching"],
  uiSounds: true,
  haptics: true,
  contentLanguage: "",
  languageGrouping: true,
  videoScale: "fit",
  monoAudio: false,
  captionsAuto: false,
  audioTranscodeAuto: false,
  externalPlayerPref: "mpv",
  androidNativePlayer: false,
  writeNfo: false,
  progressRetentionDays: 90,
  networkTimeoutSeconds: 20,
  updateChannel: "stable",
  autoUpdate: true,
  closeToTray: true,
  devMode: false,
  discordClientId: "",
  discordMuted: new Set<string>(),
  receiverDeviceName: "",
  receiverMode: false,
  receiverBoot: false,
  receiverEngine: "auto",
}

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getUserAgent: () => settingsState.userAgent,
  setUserAgent: (ua: string) => { settingsState.userAgent = ua },
  getDownloadDir: () => settingsState.downloadDir,
  setDownloadDir: (dir: string) => { settingsState.downloadDir = dir },
  downloadDirMatchesPlatform: () => true,
  getDownloadConcurrency: () => settingsState.downloadConcurrency,
  setDownloadConcurrency: (n: number) => { settingsState.downloadConcurrency = n },
  getPlayerBackend: () => settingsState.playerBackend,
  setPlayerBackend: (backend: string) => { settingsState.playerBackend = backend },
  getPlayerPath: (kind: "mpv" | "vlc") => settingsState.playerPaths[kind],
  setPlayerPath: (kind: "mpv" | "vlc", path: string) => { settingsState.playerPaths[kind] = path },
  getPlayerExtraArgs: (kind: "mpv" | "vlc") => settingsState.playerExtraArgs[kind],
  setPlayerExtraArgs: (kind: "mpv" | "vlc", args: string[]) => { settingsState.playerExtraArgs[kind] = args },
  getPlayerReuseInstance: (kind: "mpv" | "vlc") => settingsState.playerReuse[kind],
  setPlayerReuseInstance: (kind: "mpv" | "vlc", on: boolean) => { settingsState.playerReuse[kind] = on },
  getTmdbApiKey: () => settingsState.tmdbKey,
  setTmdbApiKey: (key: string) => { settingsState.tmdbKey = key },
  getTmdbEnabled: () => settingsState.tmdbEnabled,
  setTmdbEnabled: (enabled: boolean) => { settingsState.tmdbEnabled = enabled },
  getTvdbEnabled: () => settingsState.tvdbEnabled,
  setTvdbEnabled: (enabled: boolean) => { settingsState.tvdbEnabled = enabled },
  getPerfMode: () => settingsState.perfMode,
  setPerfMode: (on: boolean) => { settingsState.perfMode = on },
  getAccent: () => settingsState.accent,
  setAccent: (accent: string) => { settingsState.accent = accent },
  ACCENT_PRESETS: ["fuchsia", "rose", "ember", "emerald", "cyan", "blue", "violet"],
  ACCENT_RANDOM_ID: "random",
  getDensity: () => settingsState.density,
  setDensity: (density: string) => { settingsState.density = density },
  DENSITY_PRESETS: { compact: 0.75, cozy: 1, comfortable: 1.3 },
  getHubStripIds: () => settingsState.hubStripIds,
  setHubStripIds: (ids: string[]) => { settingsState.hubStripIds = ids },
  getUiSoundsEnabled: () => settingsState.uiSounds,
  setUiSoundsEnabled: (on: boolean) => { settingsState.uiSounds = on },
  getHapticsEnabled: () => settingsState.haptics,
  setHapticsEnabled: (on: boolean) => { settingsState.haptics = on },
  getContentLanguage: () => settingsState.contentLanguage,
  setContentLanguage: (tag: string) => { settingsState.contentLanguage = tag },
  getLanguageGroupingEnabled: () => settingsState.languageGrouping,
  setLanguageGroupingEnabled: (on: boolean) => { settingsState.languageGrouping = on },
  getVideoScale: () => settingsState.videoScale,
  setVideoScale: (mode: string) => { settingsState.videoScale = mode },
  getMonoAudioEnabled: () => settingsState.monoAudio,
  setMonoAudioEnabled: (on: boolean) => { settingsState.monoAudio = on },
  getCaptionsAutoEnabled: () => settingsState.captionsAuto,
  setCaptionsAutoEnabled: (on: boolean) => { settingsState.captionsAuto = on },
  getAudioTranscodeAuto: () => settingsState.audioTranscodeAuto,
  setAudioTranscodeAuto: (on: boolean) => { settingsState.audioTranscodeAuto = on },
  getExternalPlayerPref: () => settingsState.externalPlayerPref,
  setExternalPlayerPref: (pref: string) => { settingsState.externalPlayerPref = pref },
  EXTERNAL_PLAYER_PREF_VALUES: ["mpv", "vlc", "ask"],
  getAndroidNativePlayerEnabled: () => settingsState.androidNativePlayer,
  setAndroidNativePlayerEnabled: (on: boolean) => { settingsState.androidNativePlayer = on },
  getWriteNfoEnabled: () => settingsState.writeNfo,
  setWriteNfoEnabled: (on: boolean) => { settingsState.writeNfo = on },
  getProgressRetentionDays: () => settingsState.progressRetentionDays,
  setProgressRetentionDays: (days: number) => { settingsState.progressRetentionDays = days },
  PROGRESS_RETENTION_VALUES: [30, 90, 180, 0],
  getNetworkTimeoutSeconds: () => settingsState.networkTimeoutSeconds,
  setNetworkTimeoutSeconds: (seconds: number) => { settingsState.networkTimeoutSeconds = seconds },
  NETWORK_TIMEOUT_VALUES: [20, 45, 90, 180],
  getUpdateChannel: () => settingsState.updateChannel,
  setUpdateChannel: (channel: string) => { settingsState.updateChannel = channel },
  UPDATE_CHANNELS: ["stable", "beta"],
  getAutoUpdateEnabled: () => settingsState.autoUpdate,
  setAutoUpdateEnabled: (on: boolean) => { settingsState.autoUpdate = on },
  getCloseToTray: () => settingsState.closeToTray,
  setCloseToTray: (on: boolean) => { settingsState.closeToTray = on },
  getDevModeEnabled: () => settingsState.devMode,
  setDevModeEnabled: (on: boolean) => { settingsState.devMode = on },
  getDiscordClientId: () => settingsState.discordClientId,
  setDiscordClientId: (id: string) => { settingsState.discordClientId = id },
  isDiscordEnabledForPlaylist: (playlistId: string) => !settingsState.discordMuted.has(playlistId),
  setDiscordEnabledForPlaylist: (playlistId: string, on: boolean) => {
    if (on) settingsState.discordMuted.delete(playlistId)
    else settingsState.discordMuted.add(playlistId)
  },
  getReceiverDeviceName: () => settingsState.receiverDeviceName,
  setReceiverDeviceName: (name: string) => { settingsState.receiverDeviceName = name },
  getReceiverModeEnabled: () => settingsState.receiverMode,
  setReceiverModeEnabled: (on: boolean) => { settingsState.receiverMode = on },
  getReceiverBootEnabled: () => settingsState.receiverBoot,
  setReceiverBootEnabled: (on: boolean) => { settingsState.receiverBoot = on },
  getReceiverEngine: () => settingsState.receiverEngine,
  RECEIVER_ENGINE_VALUES: ["auto", "embedded", "native"],
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

const epgOffsets = new Map<string, number>()
vi.mock("@/scripts/lib/epg-data.js", () => ({
  getOffsetSetting: (playlistId: string) => epgOffsets.get(playlistId) ?? "auto",
  setOffsetSetting: (playlistId: string, value: "auto" | number) => {
    if (value === "auto") epgOffsets.delete(playlistId)
    else epgOffsets.set(playlistId, value)
  },
}))

let activeLocale = "en"
const setLocale = vi.fn(async (code: string) => {
  activeLocale = code
})
vi.mock("@/scripts/lib/i18n.js", () => ({
  setLocale: (code: string) => setLocale(code),
  getActiveLocale: () => activeLocale,
}))

let tvDevices: any[] = []
vi.mock("@/scripts/lib/tv-cast.js", () => ({
  listTvDevices: () => tvDevices,
  saveTvDevice: (device: any) => {
    const existingIndex = tvDevices.findIndex((entry) => entry.id === device.id)
    if (existingIndex === -1) tvDevices.push(device)
    else tvDevices[existingIndex] = device
  },
}))

import { exportAll, importAll, BACKUP_SECTIONS, isBackupBlob } from "@/scripts/lib/backup.js"

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

const sampleTvDevice = {
  id: "dev-1",
  name: "Living Room TV",
  host: "192.168.1.42",
  port: 8787,
  key: "secret-key",
  createdAt: 1000,
  lastSeenAt: 2000,
}

beforeEach(() => {
  localContentStore.clear()
  prefsSnapshot = {}
  restoredCredsState.mockClear()
  restorePrefs.mockClear()
  setLocale.mockClear()
  epgOffsets.clear()
  tvDevices = []
  activeLocale = "en"
  settingsState = {
    userAgent: "",
    downloadDir: "",
    downloadConcurrency: 2,
    playerBackend: "videojs",
    playerPaths: { mpv: "", vlc: "" },
    playerExtraArgs: { mpv: [], vlc: [] },
    playerReuse: { mpv: false, vlc: false },
    tmdbKey: "",
    tmdbEnabled: false,
    tvdbEnabled: true,
    perfMode: false,
    accent: "fuchsia",
    density: "cozy",
    hubStripIds: ["continue-watching"],
    uiSounds: true,
    haptics: true,
    contentLanguage: "",
    languageGrouping: true,
    videoScale: "fit",
    monoAudio: false,
    captionsAuto: false,
    audioTranscodeAuto: false,
    externalPlayerPref: "mpv",
    androidNativePlayer: false,
    writeNfo: false,
    progressRetentionDays: 90,
    networkTimeoutSeconds: 20,
    updateChannel: "stable",
    autoUpdate: true,
    closeToTray: true,
    devMode: false,
    discordClientId: "",
    discordMuted: new Set<string>(),
    receiverDeviceName: "",
    receiverMode: false,
    receiverBoot: false,
    receiverEngine: "auto",
  }
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
    expect(snapshot.localContent["cust-1"]).toEqual(JSON.parse(customDoc))
    expect(snapshot.localContent["loc-1"]).toBe("#EXTM3U\n")
  })

  it("keeps the raw string when a custom-playlist doc isn't valid JSON", async () => {
    localContentStore.set("cust-1", "not json")

    const snapshot = (await exportAll()) as BackupSnapshot

    expect(snapshot.localContent["cust-1"]).toBe("not json")
  })

  it("skips entry types that have no stored content", async () => {
    localContentStore.set("src-1", "should not be exported")

    const snapshot = (await exportAll()) as BackupSnapshot

    expect(snapshot.localContent["src-1"]).toBeUndefined()
  })

  it("includes the TMDb key and enabled flag", async () => {
    settingsState.tmdbKey = "abc123"
    settingsState.tmdbEnabled = true

    const snapshot = (await exportAll()) as any

    expect(snapshot.appSettings.tmdbKey).toBe("abc123")
    expect(snapshot.appSettings.tmdbEnabled).toBe(true)
  })

  it("includes the TVDb enabled flag", async () => {
    settingsState.tvdbEnabled = false

    const snapshot = (await exportAll()) as any

    expect(snapshot.appSettings.tvdbEnabled).toBe(false)
  })

  it("includes the display/UX group", async () => {
    settingsState.accent = "rose"
    settingsState.density = "compact"
    settingsState.perfMode = true

    const snapshot = (await exportAll()) as any

    expect(snapshot.appSettings.display.accent).toBe("rose")
    expect(snapshot.appSettings.display.density).toBe("compact")
    expect(snapshot.appSettings.display.perfMode).toBe(true)
    expect(snapshot.appSettings.display.hubStrips).toEqual(["continue-watching"])
  })

  it("includes only user-set EPG offsets, keyed by entry id", async () => {
    epgOffsets.set("src-1", 120)

    const snapshot = (await exportAll()) as any

    expect(snapshot.epgOffsets).toEqual({ "src-1": 120 })
    expect(snapshot.epgOffsets["loc-1"]).toBeUndefined()
  })

  it("includes the raw paired TV device list", async () => {
    tvDevices = [sampleTvDevice]

    const snapshot = (await exportAll()) as any

    expect(snapshot.tvDevices).toEqual([sampleTvDevice])
  })

  it("includes only muted discord playlist ids", async () => {
    settingsState.discordMuted.add("src-1")

    const snapshot = (await exportAll()) as any

    expect(snapshot.appSettings.discord.mutedPlaylistIds).toEqual(["src-1"])
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

  it("round-trips the TMDb key and enabled flag through export then import", async () => {
    settingsState.tmdbKey = "abc123"
    settingsState.tmdbEnabled = true
    const snapshot = await exportAll()
    settingsState.tmdbKey = ""
    settingsState.tmdbEnabled = false

    const summary = await importAll(snapshot)

    expect(settingsState.tmdbKey).toBe("abc123")
    expect(settingsState.tmdbEnabled).toBe(true)
    expect(summary.appSettings).toBeGreaterThan(0)
  })

  it("round-trips the TVDb enabled flag through export then import", async () => {
    settingsState.tvdbEnabled = false
    const snapshot = await exportAll()
    settingsState.tvdbEnabled = true

    await importAll(snapshot)

    expect(settingsState.tvdbEnabled).toBe(false)
  })

  it("leaves the TVDb flag untouched when an old backup lacks it", async () => {
    settingsState.tvdbEnabled = true

    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [], selectedId: "" },
      prefs: {},
      appSettings: { tmdbKey: "" },
    })

    expect(settingsState.tvdbEnabled).toBe(true)
  })

  it("clears the TMDb key when the backup carries an empty string", async () => {
    settingsState.tmdbKey = "old-key"

    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [], selectedId: "" },
      prefs: {},
      appSettings: { tmdbKey: "" },
    })

    expect(settingsState.tmdbKey).toBe("")
  })

  it("round-trips the display/UX group", async () => {
    settingsState.accent = "cyan"
    settingsState.density = "comfortable"
    settingsState.uiSounds = false
    settingsState.hubStripIds = ["favorites", "watchlist"]
    const snapshot = await exportAll()
    settingsState.accent = "fuchsia"
    settingsState.density = "cozy"
    settingsState.uiSounds = true
    settingsState.hubStripIds = ["continue-watching"]

    await importAll(snapshot)

    expect(settingsState.accent).toBe("cyan")
    expect(settingsState.density).toBe("comfortable")
    expect(settingsState.uiSounds).toBe(false)
    expect(settingsState.hubStripIds).toEqual(["favorites", "watchlist"])
  })

  it("round-trips the random accent sentinel", async () => {
    settingsState.accent = "random"
    const snapshot = await exportAll()
    settingsState.accent = "fuchsia"

    await importAll(snapshot)

    expect(settingsState.accent).toBe("random")
  })

  it("round-trips the language group through the i18n setter", async () => {
    activeLocale = "de"
    const snapshot = await exportAll()
    activeLocale = "en"

    await importAll(snapshot)

    expect(setLocale).toHaveBeenCalledWith("de")
  })

  it("round-trips playback and behavior fields", async () => {
    settingsState.videoScale = "zoom"
    settingsState.monoAudio = true
    settingsState.externalPlayerPref = "vlc"
    settingsState.progressRetentionDays = 30
    settingsState.updateChannel = "beta"
    const snapshot = await exportAll()
    settingsState.videoScale = "fit"
    settingsState.monoAudio = false
    settingsState.externalPlayerPref = "mpv"
    settingsState.progressRetentionDays = 90
    settingsState.updateChannel = "stable"

    await importAll(snapshot)

    expect(settingsState.videoScale).toBe("zoom")
    expect(settingsState.monoAudio).toBe(true)
    expect(settingsState.externalPlayerPref).toBe("vlc")
    expect(settingsState.progressRetentionDays).toBe(30)
    expect(settingsState.updateChannel).toBe("beta")
  })

  it("round-trips the discord client id and only restores muted ids for imported entries", async () => {
    settingsState.discordClientId = "123456"
    settingsState.discordMuted.add("src-1")
    const snapshot = await exportAll()
    settingsState.discordClientId = ""
    settingsState.discordMuted.clear()

    await importAll(snapshot)

    expect(settingsState.discordClientId).toBe("123456")
    expect(settingsState.discordMuted.has("src-1")).toBe(true)
  })

  it("ignores a muted discord playlist id absent from the imported entries", async () => {
    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [{ _id: "src-1", type: "xtream" }], selectedId: "src-1" },
      prefs: {},
      appSettings: { discord: { mutedPlaylistIds: ["unknown-id"] } },
    })

    expect(settingsState.discordMuted.has("unknown-id")).toBe(false)
  })

  it("round-trips the receiver device name, mode and boot flag", async () => {
    settingsState.receiverDeviceName = "Bedroom"
    settingsState.receiverMode = true
    settingsState.receiverBoot = true
    const snapshot = await exportAll()
    settingsState.receiverDeviceName = ""
    settingsState.receiverMode = false
    settingsState.receiverBoot = false

    await importAll(snapshot)

    expect(settingsState.receiverDeviceName).toBe("Bedroom")
    expect(settingsState.receiverMode).toBe(true)
    expect(settingsState.receiverBoot).toBe(true)
  })

  // xt_receiver_engine has no app-settings.js setter yet, so backup.js writes
  // localStorage directly; verify against a real-ish Storage stub.
  it("round-trips xt_receiver_engine via a direct localStorage write", async () => {
    class MemoryStorage {
      private store = new Map<string, string>()
      getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null }
      setItem(key: string, value: string) { this.store.set(key, String(value)) }
      removeItem(key: string) { this.store.delete(key) }
    }
    const memoryStorage = new MemoryStorage()
    vi.stubGlobal("localStorage", memoryStorage as unknown as Storage)
    try {
      settingsState.receiverEngine = "native"
      const snapshot = await exportAll()
      settingsState.receiverEngine = "auto"

      await importAll(snapshot)

      expect(memoryStorage.getItem("xt_receiver_engine")).toBe("native")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("round-trips per-playlist EPG offsets, restoring only entries present in the backup", async () => {
    epgOffsets.set("src-1", -60)
    const snapshot = await exportAll()
    epgOffsets.clear()

    await importAll(snapshot)

    expect(epgOffsets.get("src-1")).toBe(-60)
  })

  it("skips an EPG offset whose entry id is absent from the imported creds", async () => {
    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [{ _id: "src-1", type: "xtream" }], selectedId: "src-1" },
      prefs: {},
      epgOffsets: { "unknown-id": 30 },
    })

    expect(epgOffsets.has("unknown-id")).toBe(false)
  })

  it("round-trips the paired TV device list with a shape sanity check", async () => {
    tvDevices = [sampleTvDevice]
    const snapshot = await exportAll()
    tvDevices = []

    const summary = await importAll(snapshot)

    expect(tvDevices).toEqual([sampleTvDevice])
    expect(summary.appSettings).toBeGreaterThan(0)
  })

  it("rejects a malformed TV device entry", async () => {
    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [], selectedId: "" },
      prefs: {},
      tvDevices: [{ id: "dev-1", name: "Missing fields" }],
    })

    expect(tvDevices).toEqual([])
  })

  it("stores a stringified object localContent value and a string value verbatim", async () => {
    const doc = { version: 1, nextId: 1, groups: [], channels: [] }
    await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: {
        entries: [
          { _id: "cust-1", type: "custom" },
          { _id: "loc-1", type: "local-m3u" },
        ],
        selectedId: "",
      },
      prefs: {},
      localContent: { "cust-1": doc, "loc-1": "#EXTM3U\n" },
    })

    expect(localContentStore.get("cust-1")).toBe(JSON.stringify(doc))
    expect(localContentStore.get("loc-1")).toBe("#EXTM3U\n")
  })

  it("with sections: ['prefs'] skips creds and app settings but restores prefs", async () => {
    await importAll(
      {
        format: "extreme-infinitv-backup",
        version: 1,
        creds: { entries: [{ _id: "src-1", type: "xtream" }], selectedId: "src-1" },
        prefs: { "src-1": {} },
        appSettings: { userAgent: "custom-ua" },
      },
      { sections: ["prefs"] }
    )

    expect(restoredCredsState).not.toHaveBeenCalled()
    expect(settingsState.userAgent).toBe("")
    expect(restorePrefs).toHaveBeenCalledWith({ "src-1": {} })
  })

  it("with creds skipped still applies epgOffsets for entries present in current creds state", async () => {
    await importAll(
      {
        format: "extreme-infinitv-backup",
        version: 1,
        creds: { entries: [{ _id: "other-id", type: "xtream" }], selectedId: "other-id" },
        prefs: {},
        epgOffsets: { "src-1": 45, "other-id": 60 },
      },
      { sections: ["epgOffsets"] }
    )

    expect(epgOffsets.get("src-1")).toBe(45)
    expect(epgOffsets.has("other-id")).toBe(false)
  })

  it("summary includes the applied sections", async () => {
    const summary = await importAll(
      {
        format: "extreme-infinitv-backup",
        version: 1,
        creds: { entries: [], selectedId: "" },
        prefs: {},
      },
      { sections: ["prefs", "epgOffsets"] }
    )

    expect(summary.sections).toEqual(["epgOffsets", "prefs"])
  })

  it("does a full prefs replace when creds is ticked", async () => {
    const summary = await importAll({
      format: "extreme-infinitv-backup",
      version: 2,
      creds: { entries: [{ _id: "src-1", type: "xtream" }], selectedId: "src-1" },
      prefs: { "src-1": { favLive: ["x"] } },
    })

    expect(restorePrefs).toHaveBeenCalledWith({ "src-1": { favLive: ["x"] } })
    expect(summary.prefsPlaylists).toBe(1)
  })

  it("merges prefs when creds is unticked: keeps a local bucket absent from the file and drops an incoming bucket whose id isn't local", async () => {
    credsState = { entries: [{ _id: "local-1", type: "xtream" }], selectedId: "local-1" }
    prefsSnapshot = { "local-1": { favLive: ["existing"] }, "local-2": { favLive: ["also-local"] } }

    const summary = await importAll(
      {
        format: "extreme-infinitv-backup",
        version: 2,
        creds: { entries: [{ _id: "file-1", type: "xtream" }], selectedId: "file-1" },
        prefs: { "file-1": { favLive: ["from-file"] }, "local-1": { favLive: ["overlaid"] } },
      },
      { sections: ["prefs"] }
    )

    expect(restorePrefs).toHaveBeenCalledWith({
      "local-1": { favLive: ["overlaid"] },
      "local-2": { favLive: ["also-local"] },
    })
    expect(summary.prefsPlaylists).toBe(1)
  })

  it("skips a localContent entry whose id is absent from the current creds state", async () => {
    credsState = { entries: [{ _id: "local-1", type: "custom" }], selectedId: "local-1" }

    const summary = await importAll(
      {
        format: "extreme-infinitv-backup",
        version: 2,
        creds: { entries: [{ _id: "file-1", type: "custom" }], selectedId: "file-1" },
        prefs: {},
        localContent: { "file-1": "should be skipped", "local-1": "should be applied" },
      },
      { sections: ["localContent"] }
    )

    expect(localContentStore.has("file-1")).toBe(false)
    expect(localContentStore.get("local-1")).toBe("should be applied")
    expect(summary.localContent).toBe(1)
  })
})

describe("format version", () => {
  it("exports the current format version", async () => {
    const snapshot = (await exportAll()) as any
    expect(snapshot.version).toBe(2)
  })

  it("still imports a version-1 blob", async () => {
    const summary = await importAll({
      format: "extreme-infinitv-backup",
      version: 1,
      creds: { entries: [{ _id: "src-1", type: "xtream" }], selectedId: "src-1" },
      prefs: {},
    })

    expect(summary.playlists).toBe(1)
  })

  it("rejects a blob whose version is newer than this app supports", async () => {
    await expect(
      importAll({
        format: "extreme-infinitv-backup",
        version: 3,
        creds: { entries: [], selectedId: "" },
        prefs: {},
      })
    ).rejects.toThrow(/newer than this app supports/)
  })
})

describe("isBackupBlob", () => {
  it("accepts the current format name and a numeric version", () => {
    expect(isBackupBlob({ format: "extreme-infinitv-backup", version: 2 })).toBe(true)
  })

  it("accepts a legacy format name", () => {
    expect(isBackupBlob({ format: "xtream-infinitv-backup", version: 1 })).toBe(true)
  })

  it("rejects a missing or wrong format marker", () => {
    expect(isBackupBlob({ version: 1 })).toBe(false)
    expect(isBackupBlob({ format: "not-a-backup", version: 1 })).toBe(false)
  })

  it("rejects a non-object or a non-numeric version", () => {
    expect(isBackupBlob(null)).toBe(false)
    expect(isBackupBlob("nope")).toBe(false)
    expect(isBackupBlob({ format: "extreme-infinitv-backup", version: "2" })).toBe(false)
  })
})

describe("BACKUP_SECTIONS", () => {
  it("lists the six known section names in order", () => {
    expect(BACKUP_SECTIONS).toEqual([
      "creds",
      "localContent",
      "epgOffsets",
      "prefs",
      "tvDevices",
      "appSettings",
    ])
  })
})
