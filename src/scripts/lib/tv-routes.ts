// Layout.astro / TvLayout.astro embed these tables via define:vars into pre-paint inline scripts.

export const TV_ROUTE_TABLE: Readonly<Record<string, string>> = {
  "/": "/tv",
  "/livetv": "/tv/live",
  "/epg": "/tv/live",
  "/movies": "/tv/movies",
  "/movies/detail": "/tv/movies/detail",
  "/series": "/tv/series",
  "/series/detail": "/tv/series/detail",
  "/search": "/tv/search",
  "/downloads": "/tv/downloads",
  "/settings": "/tv/settings",
  "/login": "/tv/login",
  "/favorites": "/tv",
  "/watchlist": "/tv",
  "/recently-added": "/tv",
  "/playlist-editor": "/tv",
}

export const CLASSIC_ROUTE_TABLE: Readonly<Record<string, string>> = {
  "/tv": "/",
  "/tv/live": "/livetv",
  "/tv/movies": "/movies",
  "/tv/movies/detail": "/movies/detail",
  "/tv/series": "/series",
  "/tv/series/detail": "/series/detail",
  "/tv/search": "/search",
  "/tv/downloads": "/downloads",
  "/tv/settings": "/settings",
  "/tv/login": "/login",
}

const QUERY_PRESERVING_TV_PATHS = new Set(["/tv/movies/detail", "/tv/series/detail", "/tv/search"])
const QUERY_PRESERVING_CLASSIC_PATHS = new Set(["/movies/detail", "/series/detail", "/search"])

export function normalizePathname(pathname: string): string {
  const collapsed = pathname.replace(/\/+$/, "")
  return collapsed === "" ? "/" : collapsed
}

export function isTvPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname)
  return normalized === "/tv" || normalized.startsWith("/tv/")
}

export function lookupRoute(table: Record<string, string>, pathname: string): string | null {
  const normalized = normalizePathname(pathname)
  return table[normalized] ?? null
}

function normalizeSearch(search?: string): string {
  if (!search) return ""
  return search.startsWith("?") ? search : `?${search}`
}

export function tvRouteFor(pathname: string, search?: string): string | null {
  const normalized = normalizePathname(pathname)
  if (isTvPath(normalized) || normalized === "/receiver") return null
  const target = lookupRoute(TV_ROUTE_TABLE, normalized)
  if (!target) return null
  const query = QUERY_PRESERVING_TV_PATHS.has(target) ? normalizeSearch(search) : ""
  return target + query
}

export function classicRouteFor(pathname: string, search?: string): string | null {
  const normalized = normalizePathname(pathname)
  if (!isTvPath(normalized)) return null
  const target = lookupRoute(CLASSIC_ROUTE_TABLE, normalized) ?? "/"
  const query = QUERY_PRESERVING_CLASSIC_PATHS.has(target) ? normalizeSearch(search) : ""
  return target + query
}

export const TV_NAV_HREFS = [
  "/tv",
  "/tv/live",
  "/tv/movies",
  "/tv/series",
  "/tv/search",
  "/tv/downloads",
  "/tv/settings",
] as const

export function tvNavActiveHref(pathname: string): string | null {
  const normalized = normalizePathname(pathname)
  if ((TV_NAV_HREFS as readonly string[]).includes(normalized)) return normalized
  if (normalized.startsWith("/tv/movies/")) return "/tv/movies"
  if (normalized.startsWith("/tv/series/")) return "/tv/series"
  return null
}
