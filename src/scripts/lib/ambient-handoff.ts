// Handoff file for the Android DreamService screensaver: writes the same
// ambient artwork set the in-app receiver ambient screen rotates through.
import type { AmbientEntry } from "@/scripts/lib/ambient-manifest"
import { getUserAgent } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"

const HANDOFF_FILENAME = "ambient-screensaver.json"
const HANDOFF_VERSION = 1
const HANDOFF_ENTRY_CAP = 50
const HANDOFF_FRESH_MS = 6 * 60 * 60 * 1000

export interface AmbientHandoffPayload {
  v: 1
  at: number
  ua: string | null
  entries: AmbientEntry[]
}

function hasArtwork(entry: AmbientEntry): boolean {
  return !!(entry.posterUrl || entry.backdropUrl || entry.logoUrl)
}

export function buildAmbientHandoff(entries: AmbientEntry[], ua: string | null, now: number): AmbientHandoffPayload {
  return {
    v: HANDOFF_VERSION,
    at: now,
    ua,
    entries: entries.filter(hasArtwork).slice(0, HANDOFF_ENTRY_CAP),
  }
}

export function isHandoffFresh(parsed: unknown, now: number, ttlMs: number): boolean {
  if (!parsed || typeof parsed !== "object") return false
  const at = (parsed as Record<string, unknown>).at
  if (typeof at !== "number") return false
  return now - at < ttlMs
}

const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")

const isTauriRuntime =
  typeof window !== "undefined" && (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const androidTauriAvailable = isTauriRuntime && isAndroid

export async function writeAmbientHandoff(entries: AmbientEntry[]): Promise<void> {
  if (!androidTauriAvailable) return
  try {
    const payload = buildAmbientHandoff(entries, getUserAgent() || null, Date.now())
    const { writeTextFile, BaseDirectory } = await import("@tauri-apps/plugin-fs")
    await writeTextFile(HANDOFF_FILENAME, JSON.stringify(payload), { baseDir: BaseDirectory.AppData })
  } catch (err) {
    log.warn("[xt:ambient-handoff] write failed:", err)
  }
}

async function readExistingHandoff(): Promise<unknown> {
  try {
    const { readTextFile, exists, BaseDirectory } = await import("@tauri-apps/plugin-fs")
    const fileExists = await exists(HANDOFF_FILENAME, { baseDir: BaseDirectory.AppData })
    if (!fileExists) return null
    return JSON.parse(await readTextFile(HANDOFF_FILENAME, { baseDir: BaseDirectory.AppData }))
  } catch {
    return null
  }
}

export async function maybeRefreshAmbientHandoff(getActivePlaylistId: () => string | null): Promise<void> {
  if (!androidTauriAvailable) return
  try {
    const existing = await readExistingHandoff()
    if (isHandoffFresh(existing, Date.now(), HANDOFF_FRESH_MS)) return
    const playlistId = getActivePlaylistId()
    if (!playlistId) return
    const { buildAmbientManifest } = await import("@/scripts/lib/ambient-manifest")
    const entries = await buildAmbientManifest(playlistId)
    if (entries.length === 0) return
    await writeAmbientHandoff(entries)
  } catch (err) {
    log.warn("[xt:ambient-handoff] refresh failed:", err)
  }
}
