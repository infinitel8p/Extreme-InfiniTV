// Parses mpv's track-list property into the app's shared audio/subtitle track shapes.
import { labelAudioTracks, type EmbeddedAudioTrack } from "@/scripts/lib/audio-tracks.js"
import { buildTrackLabels } from "@/scripts/lib/mp4-subtitles.js"

export interface MpvSubtitleTrack {
  id: number
  label: string
  active: boolean
}

interface MpvRawTrackEntry {
  id: number
  title: string | null
  lang: string | null
}

// mpv reports ids as numbers over JSON, but tolerate numeric strings too.
function mpvNumericId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function normalizeMpvTrackList(trackList: unknown, kind: "audio" | "sub"): MpvRawTrackEntry[] {
  if (!Array.isArray(trackList)) return []
  const entries: MpvRawTrackEntry[] = []
  for (const raw of trackList) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as Record<string, unknown>
    if (entry.type !== kind) continue
    const id = mpvNumericId(entry.id)
    if (id === null) continue
    entries.push({
      id,
      title: typeof entry.title === "string" ? entry.title : null,
      lang: typeof entry.lang === "string" ? entry.lang : null,
    })
  }
  return entries
}

/** `currentAid` is mpv's observed `aid` property, not a track's own `selected` flag. */
export function parseMpvAudioTracks(trackList: unknown, currentAid: unknown, locale = "en"): EmbeddedAudioTrack[] {
  const activeId = mpvNumericId(currentAid)
  const entries = normalizeMpvTrackList(trackList, "audio")
  return labelAudioTracks(
    entries.map((entry) => ({
      id: String(entry.id),
      name: entry.title,
      language: entry.lang,
      active: entry.id === activeId,
    })),
    locale,
  )
}

/** `currentSid` is mpv's observed `sid` property; "no" (subtitles off) yields no active track. */
export function parseMpvSubtitleTracks(trackList: unknown, currentSid: unknown, locale = "en"): MpvSubtitleTrack[] {
  const activeId = mpvNumericId(currentSid)
  const entries = normalizeMpvTrackList(trackList, "sub")
  const labeled = buildTrackLabels(
    entries.map((entry) => ({ trackId: entry.id, language: entry.lang ?? "", sampleCount: 0, name: entry.title })),
    locale,
  )
  return labeled.map((track) => ({ id: track.trackId, label: track.label, active: track.trackId === activeId }))
}

/** True when mpv's observed `sid` names an active subtitle track (a numeric id, not "no"/false). */
export function isMpvSubtitleActive(sid: unknown): boolean {
  return mpvNumericId(sid) !== null
}

/** True once mpv's track-list offers a real choice: >=1 subtitle track, or >=2 audio tracks. */
export function mpvTrackChoiceAvailable(trackList: unknown, kind: "audio" | "sub"): boolean {
  const count = normalizeMpvTrackList(trackList, kind).length
  return kind === "audio" ? count > 1 : count > 0
}
