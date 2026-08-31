// Shared TheTVDB gap-fill helpers for the Android TV movie/series detail views.
import { fetchTvdbSeason, type TvdbSeasonRef } from "@/scripts/lib/tvdb-proxy.ts"
import type { TvdbEpisode } from "@/scripts/lib/tvdb-contract"
import type { TmdbTitleEnrichment } from "@/scripts/lib/tmdb-enrich.ts"
import { fmtImdbRating } from "@/scripts/lib/format.ts"
import { log } from "@/scripts/lib/log"

export interface DetailHeroFields {
  backdropUrl: string | null
  overview: string
  genres: string
  ratingText: string
  yearText: string
}

/** Only fills gaps still empty after the resolveTitleEnrichment pass; never overwrites an existing value. */
export function fillHeroGaps(current: DetailHeroFields, enrichment: TmdbTitleEnrichment | null): DetailHeroFields {
  if (!enrichment) return current
  return {
    backdropUrl: current.backdropUrl || enrichment.backdropUrl,
    overview: current.overview || enrichment.overview,
    genres: current.genres || (enrichment.genres.length ? enrichment.genres.join(", ") : ""),
    ratingText: current.ratingText || (enrichment.voteAverage ? fmtImdbRating(enrichment.voteAverage) : ""),
    yearText: current.yearText || (enrichment.year ? String(enrichment.year) : ""),
  }
}

export async function resolveTvdbSeason(ref: TvdbSeasonRef, seasonNumber: number): Promise<TvdbEpisode[]> {
  try {
    const season = await fetchTvdbSeason(ref, seasonNumber)
    return season?.episodes || []
  } catch (error) {
    log.warn("[xt:tv-detail] TheTVDB season fetch failed:", seasonNumber, error)
    return []
  }
}

export interface TvdbEpisodePatchInput {
  title: string | null
  thumbUrl: string | null
  plot: string
}

/** Pure per-episode gap fill: title only when the current one is generic filler. */
export function patchEpisodeFromTvdb(
  current: TvdbEpisodePatchInput,
  tvdbEpisode: TvdbEpisode,
  isGenericTitle: boolean
): TvdbEpisodePatchInput {
  return {
    title: isGenericTitle && tvdbEpisode.name ? tvdbEpisode.name : current.title,
    thumbUrl: current.thumbUrl || tvdbEpisode.stillUrl,
    plot: current.plot || tvdbEpisode.overview,
  }
}
