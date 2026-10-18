// Programme search for the /epg page. Pure: takes the channel list and the
// tvg-id → programmes map, returns ranked hits with tvg-shift applied.
import { normalize, scoreNormMatch } from "@/scripts/lib/text.ts"

export interface EpgSearchProgramme {
  start: number
  stop: number
  title: string
  desc?: string
  catchupId?: string
}

export interface EpgSearchChannel {
  id: number
  name: string
  tvgId?: string
  tvgShift?: number | string
}

export interface EpgSearchHit<C extends EpgSearchChannel = EpgSearchChannel> {
  channel: C
  /** Guide-display times (tvg-shift applied); rawStart/rawStop are the XMLTV times. */
  programme: EpgSearchProgramme & { rawStart: number; rawStop: number }
  score: number
  /** True when only the description matched, not the title / channel name. */
  inDescription: boolean
}

export interface EpgSearchOptions<C extends EpgSearchChannel> {
  /** Resolves the programmes-map key for a channel (override-aware). */
  resolveTvgId: (channel: C) => string | null | undefined
  /** Inclusive lower bound on programme stop, in guide-display time. */
  from?: number
  /** Exclusive upper bound on programme start, in guide-display time. */
  to?: number
  /** Extra filter, e.g. to drop ended programmes that can't be replayed. */
  keep?: (channel: C, programme: EpgSearchHit<C>["programme"]) => boolean
  limit?: number
}

export const EPG_SEARCH_MIN_CHARS = 2
const DESC_SCORE = 1

// Normalizing every title on every keystroke is the hot path on large
// guides; programme objects are stable between loads, so memoize per object.
const titleNormCache = new WeakMap<object, string>()
const descNormCache = new WeakMap<object, string>()

function titleNorm(p: EpgSearchProgramme): string {
  let norm = titleNormCache.get(p)
  if (norm === undefined) {
    norm = normalize(p.title)
    titleNormCache.set(p, norm)
  }
  return norm
}

function descNorm(p: EpgSearchProgramme): string {
  let norm = descNormCache.get(p)
  if (norm === undefined) {
    norm = normalize(p.desc)
    descNormCache.set(p, norm)
  }
  return norm
}

export function tokenizeEpgQuery(query: string): string[] {
  const norm = normalize(query)
  if (norm.length < EPG_SEARCH_MIN_CHARS) return []
  return norm.split(" ")
}

/**
 * Hits are sorted chronologically (ties broken by score, then channel order)
 * so the result list reads like a schedule. When more than `limit` match,
 * the best-scoring ones are kept before the chronological sort.
 */
export function searchProgrammes<C extends EpgSearchChannel>(
  channels: readonly C[],
  programmes: Map<string, readonly EpgSearchProgramme[]>,
  query: string,
  opts: EpgSearchOptions<C>
): { hits: EpgSearchHit<C>[]; total: number } {
  const tokens = tokenizeEpgQuery(query)
  if (!tokens.length || !programmes.size) return { hits: [], total: 0 }

  const from = opts.from ?? -Infinity
  const to = opts.to ?? Infinity
  const limit = opts.limit ?? Infinity
  const hits: Array<EpgSearchHit<C> & { order: number }> = []

  channels.forEach((channel, order) => {
    const key = opts.resolveTvgId(channel)
    if (!key) return
    const list = programmes.get(String(key).toLowerCase())
    if (!list?.length) return
    const channelNorm = normalize(channel.name)
    const hours = Number(channel.tvgShift)
    const shiftMs = Number.isFinite(hours) ? hours * 60 * 60 * 1000 : 0

    for (const p of list) {
      const start = p.start + shiftMs
      const stop = p.stop + shiftMs
      if (stop <= from) continue
      if (start >= to) break

      // The channel name can complete a query ("sports tennis") but never
      // match on its own, or "news" would list every show on "News One".
      const title = titleNorm(p)
      let score = tokens.some((token) => title.includes(token))
        ? scoreNormMatch(`${title} ${channelNorm}`, tokens)
        : 0
      let inDescription = false
      if (!score && p.desc) {
        const desc = descNorm(p)
        if (
          tokens.some((token) => desc.includes(token)) &&
          tokens.every((token) => title.includes(token) || channelNorm.includes(token) || desc.includes(token))
        ) {
          score = DESC_SCORE
          inDescription = true
        }
      }
      if (!score) continue

      const programme = { ...p, start, stop, rawStart: p.start, rawStop: p.stop }
      if (opts.keep && !opts.keep(channel, programme)) continue
      hits.push({ channel, programme, score, inDescription, order })
    }
  })

  const total = hits.length
  let kept = hits
  if (total > limit) {
    kept = hits.slice().sort((a, b) => b.score - a.score).slice(0, limit)
  }
  kept.sort(
    (a, b) =>
      a.programme.start - b.programme.start ||
      b.score - a.score ||
      a.order - b.order
  )
  return {
    hits: kept.map(({ order: _order, ...hit }) => hit),
    total,
  }
}
