// Discord presence for cast sessions: playback happens on the receiver, so the local
// player paths that normally push presence never run.
import { setRichPresence, setIdleRichPresence } from "@/scripts/lib/discord-rpc.js"
import { getActiveEntry } from "@/scripts/lib/creds.js"
import { log } from "@/scripts/lib/log.js"
import type { CastSession, CastState } from "@/scripts/lib/tv-cast.js"

const STOPPED_STATES = new Set(["idle", "ended", "error"])
const PROGRAMME_NOTE_KEY = "xt_cast_programme_v1"
const PROGRAMME_LOOKUP_INTERVAL_MS = 30 * 1000

let activeEntry: { id: string; title: string } = { id: "", title: "" }

void getActiveEntry()
  .then((entry) => {
    activeEntry = { id: entry?._id || "", title: entry?.title || "" }
  })
  .catch(() => {})

interface LiveTarget {
  playlistId: string
  channelId: string
}

interface ProgrammeNote extends LiveTarget {
  title: string
  stop: number
}

// epg-data's programme map is in-memory and only /livetv and /epg fill it, so the resolved
// programme is mirrored to sessionStorage - every navigation is a full page load.
let programmeNote: ProgrammeNote | null = readProgrammeNote()
let lastObserved: { session: CastSession; state?: CastState } | null = null
let lastLookupAtMs = 0
let lookupInFlight = false

function readProgrammeNote(): ProgrammeNote | null {
  try {
    const raw = sessionStorage.getItem(PROGRAMME_NOTE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.playlistId !== "string" || typeof parsed?.channelId !== "string") return null
    if (typeof parsed?.title !== "string" || typeof parsed?.stop !== "number") return null
    return parsed as ProgrammeNote
  } catch {
    return null
  }
}

function writeProgrammeNote(note: ProgrammeNote | null): void {
  programmeNote = note
  try {
    if (note) sessionStorage.setItem(PROGRAMME_NOTE_KEY, JSON.stringify(note))
    else sessionStorage.removeItem(PROGRAMME_NOTE_KEY)
  } catch {}
}

function playlistIdFor(session: CastSession): string {
  return (
    session.vodContext?.playlistId ||
    session.seriesContext?.playlistId ||
    session.liveContext?.playlistId ||
    activeEntry.id
  )
}

function smallImageFor(session: CastSession): string {
  if (session.isLive) return "live"
  return session.seriesContext ? "series" : "movie"
}

function liveTargetFor(session: CastSession): LiveTarget | null {
  const context = session.liveContext
  if (!session.isLive || !context) return null
  const channelId = context.channelIds[context.index]
  return channelId ? { playlistId: context.playlistId, channelId: String(channelId) } : null
}

function noteMatches(note: ProgrammeNote | null, target: LiveTarget | null): note is ProgrammeNote {
  if (!note || !target) return false
  return note.playlistId === target.playlistId && note.channelId === target.channelId
}

function programmeTitleFor(session: CastSession): string {
  const target = liveTargetFor(session)
  if (!noteMatches(programmeNote, target)) return ""
  if (programmeNote.stop && programmeNote.stop <= Date.now()) return ""
  return programmeNote.title
}

async function resolveProgramme(target: LiveTarget): Promise<ProgrammeNote | null> {
  const { getProgrammesSync, getNowNextForChannel } = await import("@/scripts/lib/epg-data.js")
  const state = getProgrammesSync(target.playlistId)
  if (!state) return null
  const { readCachedLiveChannels } = await import("@/scripts/lib/live-catalog.ts")
  const channel = readCachedLiveChannels(target.playlistId).find(
    (entry: any) => String(entry?.id) === target.channelId
  )
  if (!channel) return null
  const { current } = getNowNextForChannel(state.programmes, channel, target.playlistId)
  if (!current?.title) return null
  return { ...target, title: current.title, stop: current.stop || 0 }
}

function refreshProgramme(session: CastSession): void {
  const target = liveTargetFor(session)
  if (!target) return
  if (!noteMatches(programmeNote, target)) writeProgrammeNote(null)
  const expired = !programmeNote || (programmeNote.stop > 0 && programmeNote.stop <= Date.now())
  if (!expired && Date.now() - lastLookupAtMs < PROGRAMME_LOOKUP_INTERVAL_MS) return
  if (lookupInFlight) return
  lookupInFlight = true
  lastLookupAtMs = Date.now()
  void resolveProgramme(target)
    .then((note) => {
      if (!note || note.title === programmeNote?.title) return
      writeProgrammeNote(note)
      if (lastObserved) pushPresence(lastObserved.session, lastObserved.state)
    })
    .catch((error) => {
      log.debug("[xt:cast-presence] programme lookup failed:", error)
    })
    .finally(() => {
      lookupInFlight = false
    })
}

function pushPresence(session: CastSession, state?: CastState): void {
  const playlistId = playlistIdFor(session)
  if (!playlistId) return
  const paused = state?.state === "paused"
  const programme = programmeTitleFor(session)
  const castingTo = `Casting to ${session.deviceName}`
  void setRichPresence({
    playlistId,
    details: `${paused ? "Paused" : "Watching"} ${session.title}`,
    state: programme ? `Casting: ${programme}` : castingTo,
    largeImage: session.logo || "logo",
    largeText: session.title,
    smallImage: smallImageFor(session),
    smallText: castingTo,
    startTimestamp: session.startedAtMs ?? session.startedAt,
  })
}

export function observeCastPresence(session: CastSession, state?: CastState): void {
  if (session.connectedOnly) return
  const playlistId = playlistIdFor(session)
  if (!playlistId) return

  if (state && STOPPED_STATES.has(state.state)) {
    lastObserved = null
    writeProgrammeNote(null)
    void setIdleRichPresence({ playlistId, playlistTitle: activeEntry.title })
    return
  }

  lastObserved = { session, state }
  refreshProgramme(session)
  pushPresence(session, state)
}

export function clearCastPresence(): void {
  lastObserved = null
  writeProgrammeNote(null)
  void setIdleRichPresence({ playlistId: activeEntry.id, playlistTitle: activeEntry.title })
}
