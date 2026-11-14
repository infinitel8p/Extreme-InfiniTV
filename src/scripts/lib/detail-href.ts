export type DetailKind = "vod" | "series"

export const DETAIL_PLAYLIST_PARAM = "pl"

export interface DetailHrefOptions {
  playlistId?: string | null
  tv?: boolean
  autoplay?: boolean
  episode?: string | number | null
  download?: boolean
}

export function detailHrefFor(
  kind: DetailKind,
  id: string | number,
  options: DetailHrefOptions = {},
): string {
  const params = new URLSearchParams()
  params.set("id", String(id))
  if (options.playlistId) params.set(DETAIL_PLAYLIST_PARAM, options.playlistId)
  if (options.autoplay) params.set("autoplay", "1")
  if (options.episode != null && options.episode !== "") params.set("episode", String(options.episode))
  if (options.download) params.set("download", "1")
  const base = kind === "vod" ? "/movies/detail" : "/series/detail"
  return `${options.tv ? "/tv" : ""}${base}?${params.toString()}`
}

export function readDetailPlaylistParam(search: string): string {
  return new URLSearchParams(search).get(DETAIL_PLAYLIST_PARAM) || ""
}
