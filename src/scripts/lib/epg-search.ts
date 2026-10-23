// Pure programme search for /epg: ranked hits with tvg-shift applied.
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
  programme: EpgSearchProgramme & { rawStart: number; rawStop: number }
  score: number
  inDescription: boolean
}

export interface EpgSearchOptions<C extends EpgSearchChannel> {
  programmesFor: (channel: C) => readonly EpgSearchProgramme[] | undefined
  from?: number
  to?: number
  keep?: (channel: C, programme: EpgSearchHit<C>["programme"]) => boolean
  limit?: number
}

export const EPG_SEARCH_MIN_CHARS = 2
const DESC_SCORE = 1

// Programme objects are stable between loads; memoize normalization per object.
const titleNormCache = new WeakMap<object, string>()
const descNormCache = new WeakMap<object, string>()

function titleNorm(programme: EpgSearchProgramme): string {
  let norm = titleNormCache.get(programme)
  if (norm === undefined) {
    norm = normalize(programme.title)
    titleNormCache.set(programme, norm)
  }
  return norm
}

function descNorm(programme: EpgSearchProgramme): string {
  let norm = descNormCache.get(programme)
  if (norm === undefined) {
    norm = normalize(programme.desc)
    descNormCache.set(programme, norm)
  }
  return norm
}

export function tokenizeEpgQuery(query: string): string[] {
  const norm = normalize(query)
  if (norm.length < EPG_SEARCH_MIN_CHARS) return []
  return norm.split(" ")
}

// Chronological; over `limit`, the best-scoring hits are kept first.
export function searchProgrammes<C extends EpgSearchChannel>(
  channels: readonly C[],
  query: string,
  opts: EpgSearchOptions<C>
): { hits: EpgSearchHit<C>[]; total: number } {
  const tokens = tokenizeEpgQuery(query)
  if (!tokens.length) return { hits: [], total: 0 }

  const from = opts.from ?? -Infinity
  const to = opts.to ?? Infinity
  const limit = opts.limit ?? Infinity
  const hits: Array<EpgSearchHit<C> & { order: number }> = []

  channels.forEach((channel, order) => {
    const list = opts.programmesFor(channel)
    if (!list?.length) return
    const channelNorm = normalize(channel.name)
    const hours = Number(channel.tvgShift)
    const shiftMs = Number.isFinite(hours) ? hours * 60 * 60 * 1000 : 0

    for (const source of list) {
      const start = source.start + shiftMs
      const stop = source.stop + shiftMs
      if (stop <= from) continue
      if (start >= to) break

      // Channel name may complete a query but never match alone ("news" vs "News One").
      const title = titleNorm(source)
      let score = tokens.some((token) => title.includes(token))
        ? scoreNormMatch(`${title} ${channelNorm}`, tokens)
        : 0
      let inDescription = false
      if (!score && source.desc) {
        const desc = descNorm(source)
        if (
          tokens.some((token) => desc.includes(token)) &&
          tokens.every((token) => title.includes(token) || channelNorm.includes(token) || desc.includes(token))
        ) {
          score = DESC_SCORE
          inDescription = true
        }
      }
      if (!score) continue

      const programme = { ...source, start, stop, rawStart: source.start, rawStop: source.stop }
      if (opts.keep && !opts.keep(channel, programme)) continue
      hits.push({ channel, programme, score, inDescription, order })
    }
  })

  const total = hits.length
  let kept = hits
  if (total > limit) {
    kept = hits.slice().sort((left, right) => right.score - left.score).slice(0, limit)
  }
  kept.sort(
    (left, right) =>
      left.programme.start - right.programme.start ||
      right.score - left.score ||
      left.order - right.order
  )
  return {
    hits: kept.map(({ order: _order, ...hit }) => hit),
    total,
  }
}
