// Pure alignment of TMDb episode-group parts onto a provider's season split.
// TMDb often files an anime's whole run as one season while providers split it
// per broadcast season; episode groups carry the real boundaries.

export interface EpisodeGroupEpisodeRef {
  seasonNumber: number
  episodeNumber: number
}

export interface EpisodeGroupPart {
  name?: string
  order?: number
  episodes: EpisodeGroupEpisodeRef[]
}

export interface ProviderSeason {
  season: number
  episodeNumbers: number[]
}

export interface MappedSeasonRef extends EpisodeGroupEpisodeRef {
  providerEpisodeNumber: number
}

export interface MappedSeason {
  season: number
  refs: MappedSeasonRef[]
}

function isSpecialsPart(part: EpisodeGroupPart): boolean {
  return part.episodes.every((episode) => episode.seasonNumber === 0)
}

/** Drops specials and empty seasons, then orders ascending - the order parts are matched in. */
export function usableProviderSeasons(seasons: ProviderSeason[]): ProviderSeason[] {
  return seasons
    .filter((entry) => Number.isFinite(entry.season) && entry.season > 0 && entry.episodeNumbers.length > 0)
    .sort((first, second) => first.season - second.season)
}

function orderedParts(parts: EpisodeGroupPart[]): EpisodeGroupPart[] {
  return parts
    .map((part, index) => ({ part, index }))
    .sort((first, second) => (first.part.order ?? first.index) - (second.part.order ?? second.index))
    .map((entry) => entry.part)
    .filter((part) => part.episodes.length > 0 && !isSpecialsPart(part))
}

/**
 * Counts must match exactly, except the provider's last season, which may be a
 * prefix of a still-airing one. Returns null rather than a partial alignment:
 * a near-miss silently attaches the wrong episode's plot and still.
 */
export function alignEpisodeGroup(
  parts: EpisodeGroupPart[],
  providerSeasons: ProviderSeason[]
): MappedSeason[] | null {
  const seasons = usableProviderSeasons(providerSeasons)
  if (seasons.length === 0) return null
  const candidates = orderedParts(parts)
  if (candidates.length < seasons.length) return null

  const mapped: MappedSeason[] = []
  for (let index = 0; index < seasons.length; index++) {
    const providerSeason = seasons[index]
    const part = candidates[index]
    const providerCount = providerSeason.episodeNumbers.length
    const isLastSeason = index === seasons.length - 1
    if (isLastSeason ? providerCount > part.episodes.length : providerCount !== part.episodes.length) {
      return null
    }
    mapped.push({
      season: providerSeason.season,
      refs: providerSeason.episodeNumbers.map((providerEpisodeNumber, episodeIndex) => ({
        ...part.episodes[episodeIndex],
        providerEpisodeNumber,
      })),
    })
  }
  return mapped
}

export function refsForSeason(mapped: MappedSeason[], season: number): MappedSeasonRef[] {
  return mapped.find((entry) => entry.season === season)?.refs ?? []
}

/** Provider season shape from an Xtream get_series_info episode map. */
export function providerSeasonsFromEpisodeMap(episodesBySeason: unknown): ProviderSeason[] {
  if (!episodesBySeason || typeof episodesBySeason !== "object") return []
  return Object.entries(episodesBySeason as Record<string, unknown>)
    .filter(([, episodes]) => Array.isArray(episodes))
    .map(([key, episodes]) => ({
      season: Number(key),
      episodeNumbers: (episodes as Array<Record<string, unknown> | null>).map(
        (episode, index) => Number(episode?.episode_num) || index + 1
      ),
    }))
}

/** Cache key component: the season shape an alignment was resolved against. */
export function providerSeasonFingerprint(seasons: ProviderSeason[]): string {
  return usableProviderSeasons(seasons)
    .map((entry) => `${entry.season}x${entry.episodeNumbers.length}`)
    .join("-")
}
