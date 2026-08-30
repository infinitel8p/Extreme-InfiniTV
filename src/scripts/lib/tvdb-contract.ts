// Wire contract shared by the app and the TheTVDB proxy Worker.

export const TVDB_CONTRACT_VERSION = 1

export const TVDB_KINDS = ["series", "movie"] as const
export type TvdbKind = (typeof TVDB_KINDS)[number]

// `official` is the broadcast split providers use; `absolute` the flat run.
export const TVDB_SEASON_ORDERS = ["official", "absolute", "dvd"] as const
export type TvdbSeasonOrder = (typeof TVDB_SEASON_ORDERS)[number]

export interface TvdbCastMember {
  name: string
  character: string
  profileUrl: string | null
}

export interface TvdbTitle {
  tvdbId: number
  title: string
  overview: string
  posterUrl: string | null
  backdropUrl: string | null
  logoUrl: string | null
  bannerUrl: string | null
  cast: TvdbCastMember[]
  genres: string[]
  year: number | null
  /** Drives the season TTL; an ended run never gains episodes. */
  status: "continuing" | "ended" | "unknown"
  trailerYoutubeKey: string | null
}

export interface TvdbEpisode {
  episodeNumber: number
  name: string
  overview: string
  stillUrl: string | null
  airedAt: string | null
}

export interface TvdbSeason {
  seasonNumber: number
  order: TvdbSeasonOrder
  episodes: TvdbEpisode[]
}

export interface TvdbEnvelope<T> {
  v: typeof TVDB_CONTRACT_VERSION
  source: "thetvdb"
  ageSeconds: number
  data: T | null
}

export interface TvdbTrendingEntry {
  tvdbId: number
  /** Present only when the upstream filter record happens to carry a TMDb remote id. */
  tmdbId?: number
  name: string
  year: number | null
  posterUrl: string | null
  backdropUrl?: string | null
  score: number
}

export type TvdbTitleResponse = TvdbEnvelope<TvdbTitle>
export type TvdbSeasonResponse = TvdbEnvelope<TvdbSeason>
export type TvdbTrendingResponse = TvdbEnvelope<TvdbTrendingEntry[]>

export function isTvdbKind(value: unknown): value is TvdbKind {
  return typeof value === "string" && (TVDB_KINDS as readonly string[]).includes(value)
}

export function isTvdbSeasonOrder(value: unknown): value is TvdbSeasonOrder {
  return typeof value === "string" && (TVDB_SEASON_ORDERS as readonly string[]).includes(value)
}
