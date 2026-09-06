// Detects a provider rejection worth hopping to the next Xtream mirror for. See `advanceMirror` in `xtream-api.js`.

// Connection-cap refusals: 458 is Xtream Codes' own code, 429/509 come from nginx-fronted panels.
export const CONNECTION_LIMIT_STATUSES = new Set<number>([429, 458, 509])

// 401/403/407 auth refusals plus the connection-limit statuses above.
export const REJECTION_STATUSES = new Set<number>([401, 403, 407, ...CONNECTION_LIMIT_STATUSES])

/** Pulls an HTTP status out of an "<details> (HTTP <status>)" suffix (hls.js/shaka style). */
export function parseHttpStatusFromDetail(errorDetail: string | null | undefined): number | null {
  if (!errorDetail) return null
  const status =
    /\bHTTP (\d{3})\b/.exec(errorDetail) || /shaka:network:1001\s+\[[^,]*,\s*(\d{3})/.exec(errorDetail)
  return status ? Number(status[1]) : null
}

export function isProviderRejection(input: {
  errorDetail?: string | null
  httpStatus?: number | null
  failureKind?: string | null
}): boolean {
  if (input.failureKind === "connection-limit") return true
  const status = input.httpStatus ?? parseHttpStatusFromDetail(input.errorDetail)
  return typeof status === "number" && REJECTION_STATUSES.has(status)
}

// Only a connection-limit rejection warrants moving the whole session's traffic to the mirror.
export function shouldRepinMirror(input: { errorDetail?: string | null; httpStatus?: number | null }): boolean {
  const status = input.httpStatus ?? parseHttpStatusFromDetail(input.errorDetail)
  return typeof status === "number" && CONNECTION_LIMIT_STATUSES.has(status)
}
