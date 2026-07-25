// Stream URL builders shared between detail pages and the poster context menu.
// Single source of truth so detail and the right-click "Copy stream URL" item
// don't drift apart on encoding, extension, or path shape.

import { fmtBase } from "@/scripts/lib/creds.js"

interface Creds {
  host: string
  port?: string | number
  user: string
  pass: string
}

/**
 * Build the canonical Xtream VOD stream URL for a movie. Mirrors the path
 * `movies/detail.ts` constructs when no `stream_url` override is present.
 *
 * Extension defaults to `mp4` when the provider didn't tag the movie with one.
 * Username, password and movieId are URL-encoded so providers with `/` or
 * spaces in any of those fields don't break the path.
 */
export function buildMovieStreamUrl(
  creds: Creds,
  movieId: string | number,
  containerExt: string | null | undefined
): string {
  const rawExt = containerExt || "mp4"
  const ext = String(rawExt).replace(/^\.+/, "").toLowerCase() || "mp4"
  return (
    fmtBase(creds.host, creds.port).replace(/\/+$/, "") +
    "/movie/" +
    encodeURIComponent(creds.user) +
    "/" +
    encodeURIComponent(creds.pass) +
    "/" +
    encodeURIComponent(String(movieId)) +
    "." +
    ext
  )
}

/** Canonical Xtream live-stream URL; mirrors stream.ts's buildDirectLiveUrl byte-for-byte so the two don't drift. */
export function buildLiveStreamUrl(
  creds: Creds,
  streamId: string | number,
  containerExt: string | null | undefined
): string {
  const ext = containerExt === "ts" ? ".ts" : ".m3u8"
  return (
    fmtBase(creds.host, creds.port) +
    "/live/" +
    encodeURIComponent(creds.user) +
    "/" +
    encodeURIComponent(creds.pass) +
    "/" +
    encodeURIComponent(streamId) +
    ext
  )
}
