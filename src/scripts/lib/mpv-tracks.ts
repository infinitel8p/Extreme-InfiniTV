// Parses mpv's track-list property into the app's shared audio/subtitle track shapes.
import { combineLanguageAndName } from "@/scripts/lib/audio-tracks.js"
import { t } from "@/scripts/lib/i18n.js"

export interface MpvSubtitleTrack {
  id: number
  label: string
  active: boolean
}

export interface MpvRawTrackEntry {
  id: number
  title: string | null
  lang: string | null
}

interface MpvFullTrackEntry extends MpvRawTrackEntry {
  codec: string | null
  channelCount: number | null
  isDefault: boolean
  forced: boolean
  external: boolean
  hearingImpaired: boolean
  visualImpaired: boolean
}

// mpv reports ids as numbers over JSON, but tolerate numeric strings too.
export function mpvNumericId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function normalizeMpvTrackList(trackList: unknown, kind: "audio" | "sub"): MpvFullTrackEntry[] {
  if (!Array.isArray(trackList)) return []
  const entries: MpvFullTrackEntry[] = []
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
      codec: typeof entry.codec === "string" ? entry.codec : null,
      channelCount: typeof entry["demux-channel-count"] === "number" ? (entry["demux-channel-count"] as number) : null,
      isDefault: entry.default === true,
      forced: entry.forced === true,
      external: entry.external === true,
      hearingImpaired: entry["hearing-impaired"] === true,
      visualImpaired: entry["visual-impaired"] === true,
    })
  }
  return entries
}

const CODEC_DISPLAY_NAMES: Record<string, string> = {
  ac3: "AC-3",
  eac3: "E-AC-3",
  dts: "DTS",
  "dts-hd": "DTS-HD",
  truehd: "TrueHD",
  aac: "AAC",
  mp3: "MP3",
  mp2: "MP2",
  opus: "Opus",
  vorbis: "Vorbis",
  flac: "FLAC",
}

function codecLabel(codec: string | null): string | null {
  if (!codec) return null
  return CODEC_DISPLAY_NAMES[codec.toLowerCase()] ?? codec.toUpperCase()
}

function channelLayoutLabel(channelCount: number | null): string | null {
  switch (channelCount) {
    case 1: return "1.0"
    case 2: return "2.0"
    case 6: return "5.1"
    case 8: return "7.1"
    default: return channelCount ? `${channelCount}ch` : null
  }
}

function languageDisplayName(languageCode: string | null, locale: string): string | null {
  const code = (languageCode || "").trim().toLowerCase()
  if (!code || code === "und") return null
  try {
    return new Intl.DisplayNames([locale, "en"], { type: "language" }).of(code) || code
  } catch {
    return code
  }
}

function trackFlagLabels(entry: MpvFullTrackEntry): string[] {
  const flags: string[] = []
  if (entry.isDefault) flags.push(t("player.mpv.track.default"))
  if (entry.forced) flags.push(t("player.mpv.track.forced"))
  if (entry.hearingImpaired) flags.push(t("player.mpv.track.sdh"))
  if (entry.visualImpaired) flags.push(t("player.mpv.track.visualImpaired"))
  if (entry.external) flags.push(t("player.mpv.track.external"))
  return flags
}

/** Label grammar: language, optional title, codec/channels for audio, then flags. */
function formatMpvTrackLabel(entry: MpvFullTrackEntry, kind: "audio" | "sub", index: number, locale: string): string {
  const languageDisplay = languageDisplayName(entry.lang, locale)
  const trackName = entry.title?.trim() || undefined
  const languageAndName = combineLanguageAndName(languageDisplay, trackName)
  const base = languageAndName ?? (kind === "audio" ? `Audio ${index + 1}` : "Unknown")

  const parts = [base]
  if (kind === "audio") {
    const codecAndChannels = [codecLabel(entry.codec), channelLayoutLabel(entry.channelCount)]
      .filter((part): part is string => !!part)
      .join(" ")
    if (codecAndChannels) parts.push(codecAndChannels)
  }
  const flags = trackFlagLabels(entry)
  if (flags.length) parts.push(flags.join(", "))
  return parts.join(" · ")
}

/** mpv track shape shared with the app's generic `EmbeddedAudioTrack` menus. */
export interface MpvAudioTrack {
  id: string
  label: string
  language: string | null
  active: boolean
}

/** `currentAid` is mpv's observed `aid` property, not a track's own `selected` flag. */
export function parseMpvAudioTracks(trackList: unknown, currentAid: unknown, locale = "en"): MpvAudioTrack[] {
  const activeId = mpvNumericId(currentAid)
  const entries = normalizeMpvTrackList(trackList, "audio")
  return entries.map((entry, index) => ({
    id: String(entry.id),
    label: formatMpvTrackLabel(entry, "audio", index, locale),
    language: entry.lang,
    active: entry.id === activeId,
  }))
}

/** `currentSid` is mpv's observed `sid` property; "no" (subtitles off) yields no active track. */
export function parseMpvSubtitleTracks(trackList: unknown, currentSid: unknown, locale = "en"): MpvSubtitleTrack[] {
  const activeId = mpvNumericId(currentSid)
  const entries = normalizeMpvTrackList(trackList, "sub")
  return entries.map((entry, index) => ({
    id: entry.id,
    label: formatMpvTrackLabel(entry, "sub", index, locale),
    active: entry.id === activeId,
  }))
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

/** Raw `{id, lang, title}` entries for track-memory matching, unlike the labeled/formatted parse* helpers above. */
export function mpvTrackCandidates(trackList: unknown, kind: "audio" | "sub"): MpvRawTrackEntry[] {
  return normalizeMpvTrackList(trackList, kind).map(({ id, title, lang }) => ({ id, title, lang }))
}
