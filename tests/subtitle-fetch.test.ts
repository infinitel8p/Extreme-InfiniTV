import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getSubtitleAutoSearch: vi.fn(() => true),
  getSubtitleLangDefault: vi.fn(() => "de"),
  getSubtitleLangBackup: vi.fn(() => "en"),
}))
vi.mock("@/scripts/lib/i18n.js", () => ({
  t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  getActiveLocale: () => "en",
}))
vi.mock("@/scripts/lib/toast.js", () => ({ toast: vi.fn() }))
vi.mock("@/scripts/lib/opensubtitles.ts", async () => {
  class OpenSubtitlesError extends Error {
    code: string
    resetTimeUtc?: string
    constructor(code: string, detail?: { resetTimeUtc?: string }) {
      super(code)
      this.code = code
      this.resetTimeUtc = detail?.resetTimeUtc
    }
  }
  return {
    OpenSubtitlesError,
    opensubtitlesAvailable: vi.fn(() => true),
    searchSubtitles: vi.fn(),
    downloadSubtitleText: vi.fn(),
    downloadSubtitleLink: vi.fn(),
  }
})

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  BaseDirectory: { AppLocalData: 1 },
}))
vi.mock("@tauri-apps/api/path", () => ({
  appLocalDataDir: vi.fn(async () => "/data"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}))

import {
  autoSearchCandidates,
  cleanSubtitleTitle,
  pickNativeCandidate,
  resolveExternalSubtitleFiles,
  resolveNativeSubtitles,
  seedSubtitleTrackPrefs,
  capPerLanguage,
  describeSubtitleError,
  getPickedSubtitle,
  isoSubtitleLanguage,
  preferredSubtitleLanguages,
  setPickedSubtitle,
  subtitlePickKey,
  subtitleUrlFor,
} from "../src/scripts/lib/subtitle-fetch"
import {
  OpenSubtitlesError,
  downloadSubtitleLink,
  downloadSubtitleText,
  opensubtitlesAvailable,
  searchSubtitles,
} from "../src/scripts/lib/opensubtitles.ts"
import type { OpenSubtitlesResult } from "../src/scripts/lib/opensubtitles-params"

function result(fileId: number, language: string, downloadCount = 0): OpenSubtitlesResult {
  return {
    id: String(fileId),
    fileId,
    language,
    release: "rel",
    hearingImpaired: false,
    fromTrusted: false,
    machineTranslated: false,
    aiTranslated: false,
    downloadCount,
    fps: null,
    featureTitle: null,
    featureYear: null,
  }
}

class FakeStorage {
  private store = new Map<string, string>()
  getItem(key: string) {
    return this.store.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.store.set(key, value)
  }
}

describe("subtitlePickKey", () => {
  it("joins playlist, kind and id", () => {
    expect(subtitlePickKey("pl1", "movie", 42)).toBe("pl1:movie:42")
  })
})

describe("pick store", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", new FakeStorage())
  })

  it("round-trips and clears picks", () => {
    const pick = { fileId: 7, label: "English", language: "en" }
    expect(getPickedSubtitle("k")).toBeNull()
    setPickedSubtitle("k", pick)
    expect(getPickedSubtitle("k")).toEqual(pick)
    setPickedSubtitle("k", null)
    expect(getPickedSubtitle("k")).toBeNull()
  })

  it("keeps other keys when one changes", () => {
    setPickedSubtitle("a", { fileId: 1, label: "A", language: "en" })
    setPickedSubtitle("b", { fileId: 2, label: "B", language: "de" })
    setPickedSubtitle("a", null)
    expect(getPickedSubtitle("b")?.fileId).toBe(2)
  })
})

describe("candidate selection", () => {
  it("caps results per language", () => {
    const list = [result(1, "de"), result(2, "de"), result(3, "de"), result(4, "de"), result(5, "en")]
    expect(capPerLanguage(list, 3).map((entry) => entry.fileId)).toEqual([1, 2, 3, 5])
  })

  it("dedupes preferred languages", () => {
    expect(preferredSubtitleLanguages("en", "en")).toEqual(["en"])
    expect(preferredSubtitleLanguages("de", "")).toEqual(["de"])
    expect(preferredSubtitleLanguages("pt_BR", "en")).toEqual(["pt-br", "en"])
  })

  it("autoSearchCandidates ranks default first and caps at 3 per language", async () => {
    vi.mocked(searchSubtitles).mockResolvedValue({
      results: [
        result(1, "en", 5),
        result(2, "de", 1),
        result(3, "de", 2),
        result(4, "de", 3),
        result(5, "de", 4),
      ],
      page: 1,
      totalPages: 1,
    })
    const candidates = await autoSearchCandidates({ kind: "movie", title: "X" })
    expect(vi.mocked(searchSubtitles).mock.calls[0]![1].languages).toEqual(["de", "en"])
    expect(candidates.map((entry) => entry.fileId)).toEqual([5, 4, 3, 1])
  })
})

describe("describeSubtitleError", () => {
  it("maps unauthorized and generic errors", () => {
    expect(describeSubtitleError(new OpenSubtitlesError("unauthorized"))).toBe("player.subtitles.signInHint")
    expect(describeSubtitleError(new OpenSubtitlesError("network"))).toBe("player.subtitles.error")
    expect(describeSubtitleError(new Error("x"))).toBe("player.subtitles.error")
  })

  it("formats the quota reset time", () => {
    const message = describeSubtitleError(
      new OpenSubtitlesError("quota", { resetTimeUtc: "2026-10-15T00:00:00Z" }),
    )
    expect(message.startsWith("player.subtitles.quotaExceeded:")).toBe(true)
    expect(message).not.toContain('"time":""')
  })
})

describe("subtitleUrlFor", () => {
  const pick = { fileId: 9, label: "English", language: "en" }

  it("uses the link from a fresh download", async () => {
    vi.mocked(downloadSubtitleText).mockResolvedValue({ text: "", remaining: 1, fileName: null, link: "https://x/y.srt" })
    expect(await subtitleUrlFor(pick)).toMatchObject({ url: "https://x/y.srt", mime: "application/x-subrip" })
  })

  it("re-requests a link on a cache hit", async () => {
    vi.mocked(downloadSubtitleText).mockResolvedValue({ text: "", remaining: null, fileName: null, link: null })
    vi.mocked(downloadSubtitleLink).mockResolvedValue("https://x/z.srt")
    expect((await subtitleUrlFor(pick))?.url).toBe("https://x/z.srt")
  })

  it("returns null on failure", async () => {
    vi.mocked(downloadSubtitleText).mockRejectedValue(new Error("boom"))
    expect(await subtitleUrlFor(pick)).toBeNull()
  })
})

describe("pickNativeCandidate", () => {
  it("prefers the default language, else the first", () => {
    const list = [result(1, "en"), result(2, "de")]
    expect(pickNativeCandidate(list, "de")?.fileId).toBe(2)
    expect(pickNativeCandidate(list, "fr")?.fileId).toBe(1)
    expect(pickNativeCandidate([], "de")).toBeNull()
  })
})

describe("cleanSubtitleTitle", () => {
  it("strips language prefixes and extracts the year", () => {
    expect(cleanSubtitleTitle("EN - The Matrix (1999)")).toEqual({ title: "The Matrix", year: 1999 })
  })
})

describe("resolveNativeSubtitles", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", new FakeStorage())
    vi.mocked(opensubtitlesAvailable).mockReturnValue(true)
    vi.mocked(downloadSubtitleText).mockResolvedValue({ text: "", remaining: 1, fileName: null, link: "https://x/a.srt" })
  })

  it("returns nothing when unavailable", async () => {
    vi.mocked(opensubtitlesAvailable).mockReturnValue(false)
    expect(await resolveNativeSubtitles({ kind: "movie", title: "X" }, "k")).toEqual([])
  })

  it("uses the stored pick without searching", async () => {
    setPickedSubtitle("k", { fileId: 3, label: "English", language: "en" })
    vi.mocked(searchSubtitles).mockClear()
    const subtitles = await resolveNativeSubtitles({ kind: "movie", title: "X" }, "k")
    expect(subtitles).toHaveLength(1)
    expect(subtitles[0]).toMatchObject({ url: "https://x/a.srt", language: "en" })
    expect(searchSubtitles).not.toHaveBeenCalled()
  })

  it("auto-searches and caps to one result", async () => {
    vi.mocked(searchSubtitles).mockResolvedValue({
      results: [result(1, "en", 5), result(2, "de", 1), result(3, "de", 2)],
      page: 1,
      totalPages: 1,
    })
    const subtitles = await resolveNativeSubtitles({ kind: "movie", title: "X" }, "none")
    expect(subtitles).toHaveLength(1)
    expect(subtitles[0]!.language).toBe("de")
  })

  it("stores the auto-chosen candidate as the pick", async () => {
    vi.mocked(searchSubtitles).mockResolvedValue({ results: [result(2, "de", 1)], page: 1, totalPages: 1 })
    await resolveNativeSubtitles({ kind: "movie", title: "X" }, "stored-key")
    expect(getPickedSubtitle("stored-key")?.fileId).toBe(2)
  })

  it("falls back to no subtitles when search fails", async () => {
    vi.mocked(searchSubtitles).mockRejectedValue(new Error("boom"))
    expect(await resolveNativeSubtitles({ kind: "movie", title: "X" }, "none")).toEqual([])
  })
})

describe("seedSubtitleTrackPrefs", () => {
  it("seeds the default language only when no sub choice is remembered", () => {
    expect(seedSubtitleTrackPrefs(null)).toEqual({ audioLang: null, subLang: "de", subOff: false })
    expect(seedSubtitleTrackPrefs({ audioLang: "en", subLang: null, subOff: false })).toEqual({
      audioLang: "en",
      subLang: "de",
      subOff: false,
    })
    const remembered = { audioLang: null, subLang: "fr", subOff: false }
    expect(seedSubtitleTrackPrefs(remembered)).toBe(remembered)
    const off = { audioLang: null, subLang: null, subOff: true }
    expect(seedSubtitleTrackPrefs(off)).toBe(off)
  })
})

describe("resolveExternalSubtitleFiles", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", new FakeStorage())
    vi.mocked(opensubtitlesAvailable).mockReturnValue(true)
  })

  it("returns nothing without a pick", async () => {
    expect(await resolveExternalSubtitleFiles("missing")).toEqual([])
    expect(await resolveExternalSubtitleFiles(undefined)).toEqual([])
  })

  it("writes the picked subtitle to a local file", async () => {
    setPickedSubtitle("k", { fileId: 4, label: "English", language: "en" })
    vi.mocked(downloadSubtitleText).mockResolvedValue({ text: "1", remaining: 1, fileName: null, link: null })
    const files = await resolveExternalSubtitleFiles("k")
    expect(files).toHaveLength(1)
    expect(files[0]!.endsWith(".srt")).toBe(true)
  })

  it("returns nothing when the download fails", async () => {
    setPickedSubtitle("k", { fileId: 4, label: "English", language: "en" })
    vi.mocked(downloadSubtitleText).mockRejectedValue(new Error("boom"))
    expect(await resolveExternalSubtitleFiles("k")).toEqual([])
  })
})

describe("isoSubtitleLanguage", () => {
  it("strips the region from regional codes", () => {
    expect(isoSubtitleLanguage("pt-br")).toBe("pt")
    expect(isoSubtitleLanguage("zh-cn")).toBe("zh")
    expect(isoSubtitleLanguage("de")).toBe("de")
  })
})
