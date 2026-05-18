// Serializer for the channel-list payload shipped to VideoActivity on Live
// TV launch. The Activity gets a single JSON-encoded array of records so it
// can switch between channels in-place without round-tripping through the
// WebView.
//
// Wire format (matches ChannelLite in VideoActivity.kt):
//   {
//     id:            string,  // stable channel id ("live:<n>" or M3U sha)
//     name:          string,
//     logo:          string,  // tvg-logo or provider logo URL, may be ""
//     streamUrl:     string,  // resolved playable URL
//     ua:            string,  // per-channel User-Agent, may be ""
//     referer:       string,  // per-channel Referer, may be ""
//     nowProgramme:  string,  // "now: <title>" string, may be ""
//   }

import { getNowNext } from "@/scripts/lib/epg-data.js"

export interface ChannelInput {
  id: string | number
  name: string
  logo?: string | null
  streamUrl: string
  /** Per-channel User-Agent from #EXTVLCOPT or provider override. */
  ua?: string | null
  /** Per-channel Referer from #EXTVLCOPT. */
  referer?: string | null
  /** XMLTV channel id used to look up the "now playing" programme. */
  tvgId?: string | null
}

export interface ChannelLite {
  id: string
  name: string
  logo: string
  streamUrl: string
  ua: string
  referer: string
  nowProgramme: string
}

/** Minimum shape we read off a programme entry. Matches the Programme type
 *  in epg-data.js without requiring callers to import that whole module. */
export interface ProgrammeLike {
  start: number
  stop: number
  title: string
  desc?: string
}

export interface SerializeOptions {
  /** Default UA applied when a channel doesn't carry its own. */
  defaultUa?: string | null
  /**
   * Programmes map keyed by tvgId. Pass `null` to skip now-programme lookup
   * (e.g. when EPG isn't loaded for the active playlist).
   */
  programmes?: Map<string, ProgrammeLike[]> | null
  /** Reference time (defaults to Date.now()). Used for unit tests. */
  atMs?: number
}

function programmeLabel(
  programmes: SerializeOptions["programmes"],
  tvgId: string | null | undefined,
  atMs: number,
): string {
  if (!programmes || !tvgId) return ""
  try {
    // getNowNext is plain JS (epg-data.js) and doesn't enforce the full
    // Programme type at runtime; pass through unchecked.
    const { current } = getNowNext(programmes as unknown as never, tvgId, atMs)
    return current?.title ? `Now: ${current.title}` : ""
  } catch {
    return ""
  }
}

/**
 * Convert the in-app channel array into the ChannelLite[] wire format. Drops
 * entries with no streamUrl (defensive against malformed M3Us).
 */
export function serializeChannelsForActivity(
  channels: ChannelInput[],
  options: SerializeOptions = {},
): ChannelLite[] {
  const atMs = options.atMs ?? Date.now()
  const defaultUa = options.defaultUa ?? ""
  const out: ChannelLite[] = []
  for (const channel of channels) {
    if (!channel?.streamUrl) continue
    out.push({
      id: String(channel.id),
      name: channel.name || "",
      logo: channel.logo || "",
      streamUrl: channel.streamUrl,
      ua: channel.ua || defaultUa || "",
      referer: channel.referer || "",
      nowProgramme: programmeLabel(options.programmes, channel.tvgId, atMs),
    })
  }
  return out
}

/** JSON-encode the serialized list for passing into the Intent extra. */
export function serializeChannelsJson(
  channels: ChannelInput[],
  options: SerializeOptions = {},
): string {
  return JSON.stringify(serializeChannelsForActivity(channels, options))
}
