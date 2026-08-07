// Session-scoped grid restore state for /movies and /series: search text,
// how many cards were rendered, scroll position, and the active person
// filter signature, keyed per playlist.

export type GridStatePage = "movies" | "series"

export interface GridPersonSignature {
  person: string
  personId: number | null
}

export interface GridState {
  search: string
  renderedCount: number
  scrollY: number
  personSignature: GridPersonSignature | null
}

const KEY_PREFIX = "xt_grid_state:"
const TTL_MS = 30 * 60 * 1000

function storageKey(page: GridStatePage, playlistId: string): string {
  return `${KEY_PREFIX}${page}:${playlistId}`
}

function parsePersonSignature(value: unknown): GridPersonSignature | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const person = typeof record.person === "string" ? record.person.trim() : ""
  if (!person) return null
  const personIdNum = Number(record.personId)
  const personId = Number.isFinite(personIdNum) && personIdNum > 0 ? personIdNum : null
  return { person, personId }
}

/** Pure: validates + coerces a stored payload, or null if malformed/expired. */
export function parseGridState(raw: string | null | undefined, nowMs: number): GridState | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null

  const record = parsed as Record<string, unknown>
  const savedAt = Number(record.savedAt)
  if (!Number.isFinite(savedAt) || nowMs - savedAt > TTL_MS) return null

  const search = typeof record.search === "string" ? record.search : ""
  const renderedCount = Math.max(0, Math.floor(Number(record.renderedCount) || 0))
  const scrollY = Math.max(0, Math.floor(Number(record.scrollY) || 0))
  const personSignature = parsePersonSignature(record.personSignature)
  return { search, renderedCount, scrollY, personSignature }
}

function readPersonSignatureFromSearch(search: string): GridPersonSignature | null {
  const params = new URLSearchParams(search)
  const person = params.get("person")
  if (!person) return null
  const personIdRaw = Number(params.get("personId"))
  const personId = Number.isFinite(personIdRaw) && personIdRaw > 0 ? personIdRaw : null
  return { person, personId }
}

/**
 * Pure: a restored state is only safe to apply when the person filter of the
 * page it was saved from matches the current URL - otherwise a forward
 * navigation into a different filter view would inherit stale scroll/search.
 */
export function gridStateMatchesLocation(state: GridState, search: string): boolean {
  const current = readPersonSignatureFromSearch(search)
  const saved = state.personSignature
  if (!saved && !current) return true
  if (!saved || !current) return false
  return saved.person === current.person && saved.personId === current.personId
}

export function saveGridState(page: GridStatePage, playlistId: string, state: GridState): void {
  if (!playlistId) return
  try {
    sessionStorage.setItem(storageKey(page, playlistId), JSON.stringify({ ...state, savedAt: Date.now() }))
  } catch {
    // sessionStorage unavailable (private mode) - restoring is a nice-to-have, not critical.
  }
}

/** One-shot: removes the stored entry as soon as it is read, valid or not. */
export function takeGridState(page: GridStatePage, playlistId: string): GridState | null {
  if (!playlistId) return null
  const key = storageKey(page, playlistId)
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
  } catch {
    return null
  }
  return parseGridState(raw, Date.now())
}
