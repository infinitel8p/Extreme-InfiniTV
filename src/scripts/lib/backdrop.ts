// Pure backdrop URL extraction shared by get_vod_info / get_series_info payloads.

export function backdropFromInfoPayload(data: unknown): string | null {
  const payload = data as { info?: any; movie_data?: any } | null | undefined
  const info = payload?.info || payload?.movie_data || {}
  const backdropPath = info.backdrop_path
  if (Array.isArray(backdropPath)) return backdropPath[0] || null
  return typeof backdropPath === "string" && backdropPath ? backdropPath : null
}
