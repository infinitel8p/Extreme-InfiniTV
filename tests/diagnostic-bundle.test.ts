import { describe, it, expect, vi } from "vitest"
import {
  summarizePlaylists,
  buildBundleManifest,
  suggestedBundleFilename,
  recentLogFileNames,
  tailLogBytes,
  decodeLogTail,
  allocateLogTailBudget,
  withTimeout,
  sanitizeDeviceNameForFilename,
  LOG_FILE_NAME_PATTERN,
  type BundleInput,
  type PlaylistSummary,
  type ReceiverLogResult,
  type LogInventoryItem,
} from "@/scripts/lib/diagnostic-bundle.js"

const SECRET_PASS = "secret-pass"
const SECRET_HOST = "my.provider.example"
const SECRET_USER = "joe-user"

describe("summarizePlaylists", () => {
  const entries: unknown[] = [
    {
      _id: "xtream-1",
      type: "xtream",
      serverUrl: `http://${SECRET_HOST}`,
      username: SECRET_USER,
      password: SECRET_PASS,
      mirrors: [{ serverUrl: "http://mirror.example", username: SECRET_USER, password: SECRET_PASS }],
      liveContainer: "ts",
      epgUrl: `http://${SECRET_HOST}/xmltv.php`,
      additionalEpgUrls: ["http://extra.example/epg1", "http://extra.example/epg2"],
      disableProviderEpg: true,
    },
    {
      _id: "m3u-1",
      type: "m3u",
      url: `http://${SECRET_USER}:${SECRET_PASS}@${SECRET_HOST}/list.m3u`,
      streamHeaders: { userAgent: "custom-ua", referer: "http://referer.example" },
    },
    {
      _id: "local-m3u-1",
      type: "local-m3u",
      sourceName: "my-file.m3u",
    },
    {
      _id: "custom-1",
      type: "custom",
    },
    null,
    "not-an-object",
    {},
  ]

  it("summarizes an xtream entry without leaking host/user/pass", () => {
    const result = summarizePlaylists(entries, "xtream-1")
    const entry = result.entries[0]
    expect(entry.type).toBe("xtream")
    expect(entry.isActive).toBe(true)
    expect(entry.hasMirrors).toBe(true)
    expect(entry.mirrorCount).toBe(1)
    expect(entry.liveContainer).toBe("ts")
    expect(entry.hasEpgOverride).toBe(true)
    expect(entry.additionalEpgUrlCount).toBe(2)
    expect(entry.providerEpgDisabled).toBe(true)
    expect(entry.hasStreamHeaders).toBe(false)
  })

  it("summarizes an m3u entry with stream headers", () => {
    const result = summarizePlaylists(entries, "xtream-1")
    const entry = result.entries[1]
    expect(entry.type).toBe("m3u")
    expect(entry.isActive).toBe(false)
    expect(entry.hasMirrors).toBe(false)
    expect(entry.mirrorCount).toBe(0)
    expect(entry.liveContainer).toBeNull()
    expect(entry.hasEpgOverride).toBe(false)
    expect(entry.hasStreamHeaders).toBe(true)
  })

  it("summarizes local-m3u and custom entries", () => {
    const result = summarizePlaylists(entries, "xtream-1")
    expect(result.entries[2].type).toBe("local-m3u")
    expect(result.entries[3].type).toBe("custom")
  })

  it("tolerates malformed entries without throwing", () => {
    const result = summarizePlaylists(entries, "xtream-1")
    expect(result.entries[4].type).toBe("unknown")
    expect(result.entries[5].type).toBe("unknown")
    expect(result.entries[6].type).toBe("unknown")
    expect(result.count).toBe(entries.length)
  })

  it("resolves activeIndex by matching _id", () => {
    const result = summarizePlaylists(entries, "m3u-1")
    expect(result.activeIndex).toBe(1)
    expect(result.entries[1].isActive).toBe(true)
    expect(result.entries[0].isActive).toBe(false)
  })

  it("returns -1 for an unresolvable active id", () => {
    const result = summarizePlaylists(entries, "does-not-exist")
    expect(result.activeIndex).toBe(-1)
    expect(result.entries.every((entry) => !entry.isActive)).toBe(true)
  })

  it("returns -1 when activeId is null", () => {
    const result = summarizePlaylists(entries, null)
    expect(result.activeIndex).toBe(-1)
  })

  it("never exposes a credential-shaped key beyond the allowlist", () => {
    const result = summarizePlaylists(entries, "xtream-1")
    const forbiddenKeyPattern = /host|url|user|pass|serverurl|token/i
    const allowedKeyNames = new Set(["hasEpgOverride", "additionalEpgUrlCount", "hasStreamHeaders"])

    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item)
        return
      }
      if (value !== null && typeof value === "object") {
        for (const [key, fieldValue] of Object.entries(value)) {
          if (!allowedKeyNames.has(key)) {
            expect(forbiddenKeyPattern.test(key)).toBe(false)
          }
          walk(fieldValue)
        }
      }
    }
    walk(result)
  })

  it("never leaks planted sentinel values anywhere in the serialized result", () => {
    const result = summarizePlaylists(entries, "xtream-1")
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(SECRET_PASS)
    expect(serialized).not.toContain(SECRET_HOST)
    expect(serialized).not.toContain(SECRET_USER)
  })
})

function baseBundleInput(overrides: Partial<BundleInput> = {}): BundleInput {
  const playlists: PlaylistSummary = { count: 0, activeIndex: -1, entries: [] }
  return {
    createdAt: new Date("2026-03-15T10:30:00Z"),
    snapshot: { appVersion: "1.7.0", platform: "windows" },
    networkLog: { capacity: 200, recorded: 0, dropped: 0, entries: [] },
    playlists,
    diagnosticResult: null,
    logFiles: [],
    ...overrides,
  }
}

describe("buildBundleManifest", () => {
  it("returns the exact file set and order without a diagnostic result", () => {
    const manifest = buildBundleManifest(baseBundleInput())
    expect(manifest.map((file) => file.name)).toEqual([
      "README.txt",
      "snapshot.json",
      "network-log.json",
      "playlist-summary.json",
    ])
  })

  it("includes diagnostic-result.json in order when a result is present", () => {
    const manifest = buildBundleManifest(
      baseBundleInput({ diagnosticResult: { verdict: "ok", steps: [] } })
    )
    expect(manifest.map((file) => file.name)).toEqual([
      "README.txt",
      "snapshot.json",
      "network-log.json",
      "playlist-summary.json",
      "diagnostic-result.json",
    ])
  })

  it("appends log files under logs/ after diagnostic-result.json", () => {
    const manifest = buildBundleManifest(
      baseBundleInput({
        diagnosticResult: { verdict: "ok", steps: [] },
        logFiles: [
          { name: "app-2026-03-15.log", text: "line one\nline two" },
          { name: "app-2026-03-14.log", text: "older" },
        ],
      })
    )
    expect(manifest.map((file) => file.name)).toEqual([
      "README.txt",
      "snapshot.json",
      "network-log.json",
      "playlist-summary.json",
      "diagnostic-result.json",
      "logs/app-2026-03-15.log",
      "logs/app-2026-03-14.log",
    ])
  })

  it("masks a credentialed URL inside the snapshot JSON", () => {
    const manifest = buildBundleManifest(
      baseBundleInput({ snapshot: { note: "http://joe:hunter2@host.example/api" } })
    )
    const snapshotFile = manifest.find((file) => file.name === "snapshot.json")
    expect(snapshotFile?.text).not.toContain("hunter2")
    expect(snapshotFile?.text).toContain("***")
  })

  it("masks a nested password field that redactDeep alone would miss", () => {
    // A bare string value like "hunter2" matches no pattern on its own; only the
    // serialized `"password":"hunter2"` JSON shape is what redactUrl catches.
    const manifest = buildBundleManifest(
      baseBundleInput({
        diagnosticResult: { auth: { password: "hunter2", nested: { token: "abc123" } } },
      })
    )
    const resultFile = manifest.find((file) => file.name === "diagnostic-result.json")
    expect(resultFile?.text).not.toContain("hunter2")
    expect(resultFile?.text).not.toContain("abc123")
  })

  it("redacts credential patterns inside log tails", () => {
    const manifest = buildBundleManifest(
      baseBundleInput({
        logFiles: [
          { name: "app-2026-03-15.log", text: "fetching http://joe:hunter2@host.example/list.m3u" },
        ],
      })
    )
    const logFile = manifest.find((file) => file.name === "logs/app-2026-03-15.log")
    expect(logFile?.text).not.toContain("hunter2")
  })

  it("redacts an Xtream-style credentialed stream URL inside an mpv-embed log tail", () => {
    const manifest = buildBundleManifest(
      baseBundleInput({
        logFiles: [
          {
            name: "mpv-embed.log",
            text: "Playing: http://host.example:8080/live/joe/hunter2/12345.ts",
          },
        ],
      })
    )
    const logFile = manifest.find((file) => file.name === "logs/mpv-embed.log")
    expect(logFile?.text).not.toContain("joe")
    expect(logFile?.text).not.toContain("hunter2")
    expect(logFile?.text).toContain("***")
  })

  it("mentions every included file in the README", () => {
    const manifest = buildBundleManifest(
      baseBundleInput({
        diagnosticResult: { verdict: "ok", steps: [] },
        logFiles: [{ name: "app-2026-03-15.log", text: "hello" }],
      })
    )
    const readme = manifest.find((file) => file.name === "README.txt")?.text ?? ""
    expect(readme).toContain("snapshot.json")
    expect(readme).toContain("network-log.json")
    expect(readme).toContain("playlist-summary.json")
    expect(readme).toContain("diagnostic-result.json")
    expect(readme).toContain("logs/app-2026-03-15.log")
  })

  it("does not mention diagnostic-result.json in the README when absent", () => {
    const manifest = buildBundleManifest(baseBundleInput())
    const readme = manifest.find((file) => file.name === "README.txt")?.text ?? ""
    expect(readme).not.toContain("diagnostic-result.json")
  })

  it("adds a receiver-logs entry for a fetched device", () => {
    const receiverLogs: ReceiverLogResult[] = [
      { deviceName: "Living Room TV", host: "192.168.1.50", status: "fetched", text: "line one\nline two\n" },
    ]
    const manifest = buildBundleManifest(baseBundleInput({ receiverLogs }))
    const entry = manifest.find((file) => file.name === "receiver-logs/Living-Room-TV.log")
    expect(entry?.text).toBe("line one\nline two\n")
  })

  it("adds a receiver-logs snapshot entry with a captured-at header", () => {
    const receiverLogs: ReceiverLogResult[] = [
      {
        deviceName: "Bedroom TV",
        host: "192.168.1.51",
        status: "snapshot",
        text: "old error line\n",
        snapshotAt: "2026-03-15T10:00:00.000Z",
      },
    ]
    const manifest = buildBundleManifest(baseBundleInput({ receiverLogs }))
    const entry = manifest.find((file) => file.name === "receiver-logs/Bedroom-TV-snapshot.log")
    expect(entry?.text).toContain("2026-03-15T10:00:00.000Z")
    expect(entry?.text).toContain("old error line")
  })

  it("adds no file for an unreachable device but still notes it in the README", () => {
    const receiverLogs: ReceiverLogResult[] = [
      { deviceName: "Kitchen TV", host: "192.168.1.52", status: "unreachable" },
    ]
    const manifest = buildBundleManifest(baseBundleInput({ receiverLogs }))
    expect(manifest.some((file) => file.name.startsWith("receiver-logs/"))).toBe(false)
    const readme = manifest.find((file) => file.name === "README.txt")?.text ?? ""
    expect(readme).toContain("Kitchen TV: unreachable")
  })

  it("redacts a credential pattern inside a receiver log tail", () => {
    const receiverLogs: ReceiverLogResult[] = [
      {
        deviceName: "Living Room TV",
        host: "192.168.1.50",
        status: "fetched",
        text: "fetching http://joe:hunter2@host.example/list.m3u",
      },
    ]
    const manifest = buildBundleManifest(baseBundleInput({ receiverLogs }))
    const entry = manifest.find((file) => file.name === "receiver-logs/Living-Room-TV.log")
    expect(entry?.text).not.toContain("hunter2")
  })

  it("omits the receiver-cast section from the README when there are no devices", () => {
    const manifest = buildBundleManifest(baseBundleInput())
    const readme = manifest.find((file) => file.name === "README.txt")?.text ?? ""
    expect(readme).not.toContain("Receiver-cast devices")
  })

  it("marks a truncated log tail with the omitted byte count", () => {
    const manifest = buildBundleManifest(
      baseBundleInput({
        logFiles: [
          {
            name: "app-2026-03-15.log",
            text: "tail lines",
            sizeBytes: 2 * 1024 * 1024,
            includedBytes: 512 * 1024,
            modifiedAt: "2026-03-15T09:00:00.000Z",
          },
        ],
      })
    )
    const logFile = manifest.find((file) => file.name === "logs/app-2026-03-15.log")
    expect(logFile?.text).toContain("omitted")
    expect(logFile?.text).toContain("2026-03-15T09:00:00.000Z")
    expect(logFile?.text).toContain("tail lines")
  })

  it("marks an untruncated log tail as the complete file", () => {
    const manifest = buildBundleManifest(
      baseBundleInput({
        logFiles: [
          { name: "app-2026-03-15.log", text: "all of it", sizeBytes: 9, includedBytes: 9 },
        ],
      })
    )
    const logFile = manifest.find((file) => file.name === "logs/app-2026-03-15.log")
    expect(logFile?.text).toContain("complete file")
    expect(logFile?.text).not.toContain("omitted")
  })

  it("writes an inventory listing every file found, attached or not", () => {
    const logInventory: LogInventoryItem[] = [
      { name: "app-2026-03-15.log", sizeBytes: 1024, modifiedAt: "2026-03-15T09:00:00.000Z", state: "full" },
      { name: "app-2026-03-01.log", sizeBytes: 4096, modifiedAt: "2026-03-01T09:00:00.000Z", state: "omitted" },
    ]
    const manifest = buildBundleManifest(
      baseBundleInput({
        logFiles: [{ name: "app-2026-03-15.log", text: "hello", sizeBytes: 1024, includedBytes: 1024 }],
        logInventory,
      })
    )
    const inventory = manifest.find((file) => file.name === "logs/INVENTORY.txt")?.text ?? ""
    expect(inventory).toContain("app-2026-03-15.log")
    expect(inventory).toContain("app-2026-03-01.log")
    expect(inventory).toContain("omitted")
    const readme = manifest.find((file) => file.name === "README.txt")?.text ?? ""
    expect(readme).toContain("logs/INVENTORY.txt")
  })

  it("adds no inventory file when nothing was enumerated", () => {
    const manifest = buildBundleManifest(baseBundleInput({ logInventory: [] }))
    expect(manifest.some((file) => file.name === "logs/INVENTORY.txt")).toBe(false)
  })
})

describe("allocateLogTailBudget", () => {
  it("gives the newest file its full per-file allowance", () => {
    expect(allocateLogTailBudget([900, 900], 500, 5000, 100)).toEqual([500, 500])
  })

  it("charges a small file only its own size", () => {
    expect(allocateLogTailBudget([10, 20], 500, 5000, 5)).toEqual([10, 20])
  })

  it("stops allocating once the total budget is spent", () => {
    expect(allocateLogTailBudget([500, 500, 500], 500, 1000, 100)).toEqual([500, 500, 0])
  })

  it("hands out the remainder when it still clears the minimum chunk", () => {
    expect(allocateLogTailBudget([500, 500], 500, 700, 100)).toEqual([500, 200])
  })

  it("skips a file when the leftover budget is below the minimum chunk", () => {
    expect(allocateLogTailBudget([500, 500], 500, 550, 100)).toEqual([500, 0])
  })

  it("treats a negative or zero size as no allowance", () => {
    expect(allocateLogTailBudget([0, -5, 10], 500, 5000, 1)).toEqual([0, 0, 10])
  })

  it("returns an empty list for no files", () => {
    expect(allocateLogTailBudget([])).toEqual([])
  })
})

describe("sanitizeDeviceNameForFilename", () => {
  it("keeps alphanumerics and collapses everything else to a dash", () => {
    expect(sanitizeDeviceNameForFilename("Living Room TV", "192.168.1.50")).toBe("Living-Room-TV")
  })

  it("keeps underscores and existing dashes", () => {
    expect(sanitizeDeviceNameForFilename("tv_1-main", "192.168.1.50")).toBe("tv_1-main")
  })

  it("falls back to the host when the name sanitizes to nothing", () => {
    expect(sanitizeDeviceNameForFilename("!!!", "192.168.1.50")).toBe("192-168-1-50")
  })

  it("falls back to 'device' when both name and host sanitize to nothing", () => {
    expect(sanitizeDeviceNameForFilename("!!!", "!!!")).toBe("device")
  })
})

describe("suggestedBundleFilename", () => {
  it("builds the expected shape from a version and local time", () => {
    const createdAt = new Date(2026, 2, 15, 9, 5, 0)
    const filename = suggestedBundleFilename("1.7.2", createdAt)
    expect(filename).toBe("extreme-infinitv-diagnostics-1.7.2-20260315-0905.zip")
  })

  it("pads single-digit month/day/hour/minute in local time", () => {
    const createdAt = new Date(2026, 0, 2, 3, 4, 0)
    const filename = suggestedBundleFilename("2.0.0", createdAt)
    expect(filename).toBe("extreme-infinitv-diagnostics-2.0.0-20260102-0304.zip")
  })

  it("falls back to 'unknown' when the version is null", () => {
    const createdAt = new Date(2026, 2, 15, 9, 5, 0)
    const filename = suggestedBundleFilename(null, createdAt)
    expect(filename).toBe("extreme-infinitv-diagnostics-unknown-20260315-0905.zip")
  })

  it("falls back to 'unknown' when the version is blank", () => {
    const createdAt = new Date(2026, 2, 15, 9, 5, 0)
    const filename = suggestedBundleFilename("   ", createdAt)
    expect(filename).toBe("extreme-infinitv-diagnostics-unknown-20260315-0905.zip")
  })
})

describe("withTimeout", () => {
  it("resolves with the value when the promise settles before the timer", async () => {
    vi.useFakeTimers()
    const promise = withTimeout(Promise.resolve("value"), 1000, "fallback")
    await vi.runAllTimersAsync()
    expect(await promise).toBe("value")
    vi.useRealTimers()
  })

  it("resolves with the fallback when the promise never settles", async () => {
    vi.useFakeTimers()
    const neverSettles = new Promise<string>(() => {})
    const promise = withTimeout(neverSettles, 1000, "fallback")
    await vi.advanceTimersByTimeAsync(1000)
    expect(await promise).toBe("fallback")
    vi.useRealTimers()
  })

  it("resolves with the fallback instead of rejecting when the promise rejects", async () => {
    vi.useFakeTimers()
    const promise = withTimeout(Promise.reject(new Error("boom")), 1000, "fallback")
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBe("fallback")
    vi.useRealTimers()
  })

  it("never rejects even when the timer fires and the promise later resolves", async () => {
    vi.useFakeTimers()
    const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 5000))
    const promise = withTimeout(slow, 1000, "fallback")
    await vi.advanceTimersByTimeAsync(1000)
    expect(await promise).toBe("fallback")
    await vi.advanceTimersByTimeAsync(4000)
    vi.useRealTimers()
  })
})

describe("recentLogFileNames", () => {
  it("returns two names newest first for days=2", () => {
    const now = new Date(2026, 2, 15)
    expect(recentLogFileNames(now, 2)).toEqual(["app-2026-03-15.log", "app-2026-03-14.log"])
  })

  it("returns seven names newest first for days=7", () => {
    const now = new Date(2026, 2, 15)
    expect(recentLogFileNames(now, 7)).toEqual([
      "app-2026-03-15.log",
      "app-2026-03-14.log",
      "app-2026-03-13.log",
      "app-2026-03-12.log",
      "app-2026-03-11.log",
      "app-2026-03-10.log",
      "app-2026-03-09.log",
    ])
  })

  it("crosses a month boundary using local dates", () => {
    const now = new Date(2026, 2, 1)
    expect(recentLogFileNames(now, 2)).toEqual(["app-2026-03-01.log", "app-2026-02-28.log"])
  })

  it("crosses a year boundary using local dates", () => {
    const now = new Date(2026, 0, 1)
    expect(recentLogFileNames(now, 2)).toEqual(["app-2026-01-01.log", "app-2025-12-31.log"])
  })

  it("returns an empty list for days=0", () => {
    const now = new Date(2026, 2, 15)
    expect(recentLogFileNames(now, 0)).toEqual([])
  })
})

describe("tailLogBytes", () => {
  it("returns the same bytes when under the cap", () => {
    const bytes = new TextEncoder().encode("hello")
    const tail = tailLogBytes(bytes, 100)
    expect(new TextDecoder().decode(tail)).toBe("hello")
  })

  it("returns the same bytes when exactly at the cap", () => {
    const bytes = new TextEncoder().encode("hello")
    const tail = tailLogBytes(bytes, bytes.length)
    expect(tail.length).toBe(bytes.length)
  })

  it("returns only the last maxBytes bytes when over the cap", () => {
    const bytes = new TextEncoder().encode("0123456789")
    const tail = tailLogBytes(bytes, 4)
    expect(new TextDecoder().decode(tail)).toBe("6789")
  })
})

describe("decodeLogTail", () => {
  it("decodes without dropping a leading line when not truncated", () => {
    const bytes = new TextEncoder().encode("first line\nsecond line")
    expect(decodeLogTail(bytes, false)).toBe("first line\nsecond line")
  })

  it("drops the partial leading line when truncated", () => {
    const full = "1234567890\ncomplete line one\ncomplete line two"
    const bytes = new TextEncoder().encode(full)
    // Simulate a truncation that lands mid-way through the first line.
    const cut = bytes.subarray(4)
    expect(decodeLogTail(cut, true)).toBe("complete line one\ncomplete line two")
  })

  it("returns an empty string when truncated with no newline at all", () => {
    const bytes = new TextEncoder().encode("no newline anywhere in here")
    expect(decodeLogTail(bytes.subarray(3), true)).toBe("")
  })

  it("does not corrupt a multibyte character that survives the cut", () => {
    const line = "before\ncafé résumé 日本語 line"
    const bytes = new TextEncoder().encode(line)
    const newlineIndex = bytes.indexOf(10)
    // Cut right at the start of the second line, before any multibyte sequence.
    const cut = bytes.subarray(newlineIndex + 1)
    expect(decodeLogTail(cut, false)).toBe("café résumé 日本語 line")
  })

  it("drops a leading line mangled by a cut multibyte sequence", () => {
    const line = "café résumé\nnext line intact"
    const bytes = new TextEncoder().encode(line)
    // "é" is bytes [0xC3, 0xA9] at indices 3-4; cutting at 4 leaves only the lone
    // continuation byte, corrupting the (soon dropped) first line only.
    const cut = bytes.subarray(4)
    const decoded = decodeLogTail(cut, true)
    expect(decoded).toBe("next line intact")
    expect(decoded).not.toContain("�")
  })
})

describe("LOG_FILE_NAME_PATTERN", () => {
  it("matches mpv-embed.log alongside the other app log names", () => {
    expect(LOG_FILE_NAME_PATTERN.test("mpv-embed.log")).toBe(true)
    expect(LOG_FILE_NAME_PATTERN.test("app-2026-03-15.log")).toBe(true)
    expect(LOG_FILE_NAME_PATTERN.test("app-2026-03-15_1.log.bak")).toBe(true)
  })

  it("rejects a path outside the flat log directory", () => {
    expect(LOG_FILE_NAME_PATTERN.test("../mpv-embed.log")).toBe(false)
    expect(LOG_FILE_NAME_PATTERN.test("sub/mpv-embed.log")).toBe(false)
    expect(LOG_FILE_NAME_PATTERN.test("mpv-embed.txt")).toBe(false)
  })
})
