// Discord presence for cast sessions: playback happens on the receiver, so the local
// player paths that normally push presence never run.
import { setRichPresence, setIdleRichPresence } from "@/scripts/lib/discord-rpc.js"
import { getActiveEntry } from "@/scripts/lib/creds.js"
import type { CastSession, CastState } from "@/scripts/lib/tv-cast.js"

const STOPPED_STATES = new Set(["idle", "ended", "error"])

let activeEntry: { id: string; title: string } = { id: "", title: "" }

void getActiveEntry()
  .then((entry) => {
    activeEntry = { id: entry?._id || "", title: entry?.title || "" }
  })
  .catch(() => {})

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

export function observeCastPresence(session: CastSession, state?: CastState): void {
  if (session.connectedOnly) return
  const playlistId = playlistIdFor(session)
  if (!playlistId) return

  if (state && STOPPED_STATES.has(state.state)) {
    void setIdleRichPresence({ playlistId, playlistTitle: activeEntry.title })
    return
  }

  const paused = state?.state === "paused"
  void setRichPresence({
    playlistId,
    details: `${paused ? "Paused" : "Watching"} ${session.title}`,
    state: `on ${session.deviceName}`,
    largeImage: session.logo || "logo",
    largeText: session.title,
    smallImage: smallImageFor(session),
    smallText: "Casting",
    startTimestamp: session.startedAtMs ?? session.startedAt,
  })
}

export function clearCastPresence(): void {
  void setIdleRichPresence({ playlistId: activeEntry.id, playlistTitle: activeEntry.title })
}
