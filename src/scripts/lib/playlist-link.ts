// Pure parser for a pasted playlist link: Xtream (username+password query
// params) or a bare M3U/M3U8 URL. Used by the TV "paste a link" field.

export type ParsedPlaylistLink =
  | { type: "xtream"; serverUrl: string; username: string; password: string }
  | { type: "m3u"; url: string }
  | null

const M3U_PATH_RX = /\.m3u8?$/i
const M3U_TYPE_RX = /type=m3u/i
const SCHEME_RX = /^([a-zA-Z][a-zA-Z\d+\-.]*):\/\//

export function parsePlaylistLink(input: string): ParsedPlaylistLink {
  const trimmed = String(input ?? "").trim()
  if (!trimmed) return null

  const schemeMatch = trimmed.match(SCHEME_RX)
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) return null
  const withScheme = schemeMatch ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol)) return null

  const username = (url.searchParams.get("username") || "").trim()
  const password = (url.searchParams.get("password") || "").trim()
  if (username && password) {
    return { type: "xtream", serverUrl: url.origin, username, password }
  }

  if (M3U_PATH_RX.test(url.pathname) || M3U_TYPE_RX.test(url.search)) {
    return { type: "m3u", url: url.href }
  }

  return null
}
