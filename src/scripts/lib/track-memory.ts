// Per-title audio/subtitle track memory: restore and persist picks, language-first with id as tiebreaker.
import { getTrackPrefs, setTrackPrefs } from "@/scripts/lib/preferences.js"
import { normalizeLang, pickTrack, type TrackCandidate } from "@/scripts/lib/track-match.ts"

export interface TrackMemoryContext {
  playlistId: string
  kind: "vod" | "episode"
  id: string
}

export interface TrackPrefs {
  audioLang: string | null
  audioId: number | null
  audioTitle: string | null
  subLang: string | null
  subId: number | null
  subTitle: string | null
  subOff: boolean
  updatedAt: number
}

export interface RememberedTrack {
  id: number | null
  lang: string | null
  title: string | null
}

export function readTrackMemory(ctx: TrackMemoryContext | null | undefined): TrackPrefs | null {
  if (!ctx) return null
  return getTrackPrefs(ctx.playlistId, ctx.kind, ctx.id)
}

export function rememberAudioTrack(ctx: TrackMemoryContext | null | undefined, track: RememberedTrack | null): void {
  if (!ctx) return
  setTrackPrefs(ctx.playlistId, ctx.kind, ctx.id, {
    audioLang: normalizeLang(track?.lang ?? null),
    audioId: track?.id ?? null,
    audioTitle: track?.title ?? null,
  })
}

/** `track` null means the viewer turned subtitles off. */
export function rememberSubtitleTrack(ctx: TrackMemoryContext | null | undefined, track: RememberedTrack | null): void {
  if (!ctx) return
  setTrackPrefs(ctx.playlistId, ctx.kind, ctx.id, {
    subOff: track === null,
    subLang: normalizeLang(track?.lang ?? null),
    subId: track?.id ?? null,
    subTitle: track?.title ?? null,
  })
}

export function chooseAudioTrackId(
  ctx: TrackMemoryContext | null | undefined,
  candidates: TrackCandidate[],
): number | null {
  const prefs = readTrackMemory(ctx)
  if (!prefs) return null
  return pickTrack(candidates, { lang: prefs.audioLang, id: prefs.audioId, title: prefs.audioTitle })
}

/** "off" when the viewer's remembered pick was subtitles off; null for no memory or no match. */
export function chooseSubtitleTrackId(
  ctx: TrackMemoryContext | null | undefined,
  candidates: TrackCandidate[],
): number | null | "off" {
  const prefs = readTrackMemory(ctx)
  if (!prefs) return null
  if (prefs.subOff) return "off"
  return pickTrack(candidates, { lang: prefs.subLang, id: prefs.subId, title: prefs.subTitle })
}
