import { t, getActiveLocale } from "@/scripts/lib/i18n.js"
import { getSubtitleAutoSearch, getSubtitleLangBackup, getSubtitleLangDefault } from "@/scripts/lib/app-settings.js"
import { toast } from "@/scripts/lib/toast.js"
import { log } from "@/scripts/lib/log.js"
import {
  OpenSubtitlesError,
  downloadSubtitleLink,
  downloadSubtitleText,
  opensubtitlesAvailable,
  searchSubtitles,
} from "@/scripts/lib/opensubtitles.ts"
import {
  rankSubtitleResults,
  subtitleResultLabel,
  toOpenSubtitlesLanguage,
  type OpenSubtitlesResult,
  type SubtitleSearchContext,
} from "@/scripts/lib/opensubtitles-params.ts"
import { subtitleLanguageName } from "@/scripts/lib/subtitle-languages.ts"
import { cleanProviderTitle } from "@/scripts/lib/tmdb-match.ts"
import type { NativeSubtitle } from "@/scripts/lib/android-video-launcher.ts"
import type { VjsLikeHandle } from "@/scripts/lib/player-runtime.js"

const PICK_STORAGE_KEY = "xt_subs_pick_v1"
const MAX_PER_LANGUAGE = 3
const NATIVE_AUTO_SEARCH_TIMEOUT_MS = 5000
const EXTERNAL_FILE_TIMEOUT_MS = 8000
const SUB_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const autoFoundToasted = new Set<string>()

export function subtitleLanguageLabel(code: string): string {
  return subtitleLanguageName(code, getActiveLocale())
}

function withTimeout(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

export interface SubtitlePick {
  fileId: number
  label: string
  language: string
}

export function subtitlePickKey(playlistId: string, kind: string, id: string | number): string {
  return `${playlistId}:${kind}:${id}`
}

function readPickMap(): Record<string, SubtitlePick> {
  try {
    const raw = sessionStorage.getItem(PICK_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function getPickedSubtitle(key: string): SubtitlePick | null {
  const pick = readPickMap()[key]
  return pick && typeof pick.fileId === "number" ? pick : null
}

export function setPickedSubtitle(key: string, pick: SubtitlePick | null): void {
  const map = readPickMap()
  if (pick) map[key] = pick
  else delete map[key]
  try {
    sessionStorage.setItem(PICK_STORAGE_KEY, JSON.stringify(map))
  } catch (err) {
    log.warn("[xt:subtitles] pick not persisted:", err)
  }
}

export function capPerLanguage(results: OpenSubtitlesResult[], limit: number): OpenSubtitlesResult[] {
  const counts = new Map<string, number>()
  return results.filter((result) => {
    const seen = counts.get(result.language) ?? 0
    if (seen >= limit) return false
    counts.set(result.language, seen + 1)
    return true
  })
}

export function preferredSubtitleLanguages(defaultLang: string, backupLang: string): string[] {
  const languages: string[] = []
  for (const raw of [defaultLang, backupLang]) {
    const code = toOpenSubtitlesLanguage(raw)
    if (code && !languages.includes(code)) languages.push(code)
  }
  return languages
}

export async function autoSearchCandidates(
  context: SubtitleSearchContext,
  options: { signal?: AbortSignal } = {}
): Promise<OpenSubtitlesResult[]> {
  if (!opensubtitlesAvailable() || !getSubtitleAutoSearch()) return []
  const defaultLang = getSubtitleLangDefault()
  const backupLang = getSubtitleLangBackup()
  const languages = preferredSubtitleLanguages(defaultLang, backupLang)
  if (!languages.length) return []
  const { results } = await searchSubtitles(context, { languages, signal: options.signal })
  const ranked = rankSubtitleResults(results, { defaultLang, backupLang })
  return capPerLanguage(
    ranked.filter((result) => languages.includes(result.language.toLowerCase())),
    MAX_PER_LANGUAGE
  )
}

export function loaderFor(result: { fileId: number }): () => Promise<{ text: string }> {
  return () => downloadSubtitleText(result.fileId).then(({ text }) => ({ text }))
}

function fileNameHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

async function pruneOldSubtitleFiles(): Promise<void> {
  try {
    const { readDir, stat, remove, BaseDirectory } = await import("@tauri-apps/plugin-fs")
    const baseDir = BaseDirectory.AppLocalData
    const cutoff = Date.now() - SUB_FILE_MAX_AGE_MS
    for (const entry of await readDir("subs", { baseDir })) {
      if (!entry.isFile) continue
      const info = await stat(`subs/${entry.name}`, { baseDir })
      if (info.mtime && new Date(info.mtime).getTime() < cutoff) await remove(`subs/${entry.name}`, { baseDir })
    }
  } catch (err) {
    log.warn("[xt:subtitles] subtitle cache prune failed:", err)
  }
}

export async function writeSubtitleTempFile(label: string, text: string): Promise<string> {
  const { writeTextFile, mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs")
  const { appLocalDataDir, join } = await import("@tauri-apps/api/path")
  const fileName = `${fileNameHash(`${label}\n${text.length}\n${text.slice(0, 256)}`)}.srt`
  await mkdir("subs", { baseDir: BaseDirectory.AppLocalData, recursive: true })
  await pruneOldSubtitleFiles()
  await writeTextFile(`subs/${fileName}`, text, { baseDir: BaseDirectory.AppLocalData })
  return join(await appLocalDataDir(), "subs", fileName)
}

export async function ensureSubtitleFile(
  source: { fileId: number; label?: string },
  options: { signal?: AbortSignal } = {}
): Promise<string> {
  const { text } = await downloadSubtitleText(source.fileId, { signal: options.signal })
  return writeSubtitleTempFile(source.label ?? String(source.fileId), text)
}

export async function subtitleUrlFor(
  pick: SubtitlePick,
  options: { signal?: AbortSignal } = {}
): Promise<{ url: string; language: string; label: string; mime: "application/x-subrip" } | null> {
  try {
    const { link } = await downloadSubtitleText(pick.fileId, { signal: options.signal })
    const url = link ?? (await downloadSubtitleLink(pick.fileId, { signal: options.signal }))
    return { url, language: pick.language, label: pick.label, mime: "application/x-subrip" }
  } catch (err) {
    log.warn("[xt:subtitles] subtitle url resolution failed:", err)
    return null
  }
}

export function cleanSubtitleTitle(rawName: string | null | undefined): { title: string; year: number | null } {
  const cleaned = cleanProviderTitle(rawName || "")
  return { title: cleaned.variants[0] ?? (rawName || "").trim(), year: cleaned.year }
}

export function pickNativeCandidate(
  candidates: OpenSubtitlesResult[],
  defaultLang: string
): OpenSubtitlesResult | null {
  const wanted = toOpenSubtitlesLanguage(defaultLang)
  return candidates.find((candidate) => candidate.language.toLowerCase() === wanted) ?? candidates[0] ?? null
}

export async function resolveNativeSubtitles(
  context: SubtitleSearchContext,
  pickKey?: string
): Promise<NativeSubtitle[]> {
  if (!opensubtitlesAvailable()) return []
  const stored = pickKey ? getPickedSubtitle(pickKey) : null
  if (!stored && !getSubtitleAutoSearch()) return []
  const bound = withTimeout(NATIVE_AUTO_SEARCH_TIMEOUT_MS)
  try {
    let pick = stored
    if (!pick) {
      const candidates = await autoSearchCandidates(context, { signal: bound.signal })
      const chosen = pickNativeCandidate(candidates, getSubtitleLangDefault())
      if (!chosen) return []
      pick = {
        fileId: chosen.fileId,
        label: subtitleResultLabel(chosen, subtitleLanguageLabel),
        language: chosen.language,
      }
    }
    const resolved = await subtitleUrlFor(pick, { signal: bound.signal })
    if (!resolved) return []
    if (!stored && pickKey) setPickedSubtitle(pickKey, pick)
    return [resolved]
  } catch (err) {
    log.warn("[xt:subtitles] native subtitle resolution failed:", err)
    return []
  } finally {
    bound.clear()
  }
}

export interface ExternalTrackPrefs {
  audioLang: string | null
  subLang: string | null
  subOff: boolean
}

export function isoSubtitleLanguage(code: string): string {
  return code.split(/[-_]/)[0]!.toLowerCase()
}

export function seedSubtitleTrackPrefs(prefs: ExternalTrackPrefs | null): ExternalTrackPrefs | null {
  if (prefs && (prefs.subLang || prefs.subOff)) return prefs
  const subLang = isoSubtitleLanguage(getSubtitleLangDefault())
  if (!subLang) return prefs
  return { audioLang: prefs?.audioLang ?? null, subLang, subOff: false }
}

export async function resolveExternalSubtitleFiles(pickKey?: string): Promise<string[]> {
  if (!pickKey || !opensubtitlesAvailable()) return []
  const stored = getPickedSubtitle(pickKey)
  if (!stored) return []
  const bound = withTimeout(EXTERNAL_FILE_TIMEOUT_MS)
  try {
    return [await ensureSubtitleFile(stored, { signal: bound.signal })]
  } catch (err) {
    log.warn("[xt:subtitles] external subtitle file failed:", err)
    if (!bound.signal.aborted) toast({ title: describeSubtitleError(err) })
    return []
  } finally {
    bound.clear()
  }
}

export function describeSubtitleError(err: unknown): string {
  if (err instanceof OpenSubtitlesError) {
    if (err.code === "quota") {
      const resetDate = err.resetTimeUtc ? new Date(err.resetTimeUtc) : null
      const time =
        resetDate && !Number.isNaN(resetDate.getTime())
          ? new Intl.DateTimeFormat(getActiveLocale(), { timeStyle: "short" }).format(resetDate)
          : ""
      return t("player.subtitles.quotaExceeded", { time })
    }
    if (err.code === "unauthorized") return t("player.subtitles.signInHint")
  }
  return t("player.subtitles.error")
}

export interface SubtitleSearchController {
  openDialog(): Promise<void>
  dispose(): void
}

export function attachSubtitleSearch(
  handle: VjsLikeHandle,
  context: SubtitleSearchContext,
  options: { pickKey?: string; autoSearch: boolean }
): SubtitleSearchController {
  const controller = new AbortController()
  const registered = new Map<number, Promise<number>>()

  const register = (result: { fileId: number; label: string; language: string }): Promise<number> => {
    const existing = registered.get(result.fileId)
    if (existing) return existing
    const pending = handle.addSubtitleTrack
      ? handle.addSubtitleTrack({ label: result.label, language: result.language, load: loaderFor(result) })
      : Promise.resolve(-1)
    registered.set(result.fileId, pending)
    return pending
  }

  const storedPick = options.pickKey ? getPickedSubtitle(options.pickKey) : null
  if (storedPick) void register(storedPick).catch((err) => log.warn("[xt:subtitles] pick restore failed:", err))

  if (options.autoSearch) {
    autoSearchCandidates(context, { signal: controller.signal })
      .then(async (results) => {
        if (controller.signal.aborted) return
        let added = 0
        for (const result of results) {
          const trackId = await register({
            fileId: result.fileId,
            label: subtitleResultLabel(result, subtitleLanguageLabel),
            language: result.language,
          })
          if (trackId >= 0) added++
        }
        const toastKey = options.pickKey ?? ""
        if (added > 0 && !controller.signal.aborted && !(toastKey && autoFoundToasted.has(toastKey))) {
          if (toastKey) autoFoundToasted.add(toastKey)
          toast({ title: t("player.subtitles.autoFound", { count: added }) })
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) log.warn("[xt:subtitles] auto search failed:", err)
      })
  }

  return {
    async openDialog() {
      const { openSubtitleSearchDialog } = await import("@/scripts/lib/subtitle-search-dialog.ts")
      await openSubtitleSearchDialog({
        context,
        pickKey: options.pickKey,
        onPick: async (result) => {
          const label = subtitleResultLabel(result, subtitleLanguageLabel)
          const trackId = await register({ fileId: result.fileId, label, language: result.language })
          if (trackId >= 0) await handle.selectSubtitleTrack?.(trackId)
        },
      })
    },
    dispose() {
      controller.abort()
      handle.removeSubtitleTracks?.()
    },
  }
}
