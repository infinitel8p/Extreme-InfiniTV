// Per-channel Xtream EPG client: get_short_epg (now/next) + get_simple_data_table (full timeline).
import { xtreamApiFetch } from "@/scripts/lib/xtream-api.js"
import { isLikelyM3USource } from "@/scripts/lib/creds.js"
import { maybeB64ToUtf8 } from "@/scripts/lib/b64-utf8.ts"
import { t } from "@/scripts/lib/i18n.js"

export interface XtreamCreds {
  host: string
  port?: string
  user: string
  pass: string
  /** Routes the fetch through a specific stored playlist entry (see xtreamApiFetch opts). */
  entryId?: string
}

export interface Programme {
  start: number
  stop: number
  title: string
  desc: string
  hasArchive?: boolean
}

export interface ShortEpgNowNext {
  current: Programme | null
  next: Programme | null
}

const SHORT_EPG_LIMIT = 4

function readTextField(primary: unknown, fallback: unknown): string {
  const source = primary ?? fallback
  if (typeof source === "string") return source
  return source == null ? "" : String(source)
}

/** Maps provider short/full-EPG rows to Programme[], dropping anything already over by nowMs. Pass 0 to keep history. */
export function mapShortEpgRows(rows: unknown, nowMs: number): Programme[] {
  if (!Array.isArray(rows)) return []
  const programmes: Programme[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const entry = row as Record<string, unknown>
    const start = Number(entry.start_timestamp ?? entry.start) * 1000
    const stop = Number(entry.stop_timestamp ?? entry.stop ?? entry.end) * 1000
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) continue
    if (stop <= nowMs) continue

    const titleText = readTextField(entry.title, entry.title_raw)
    const title = titleText ? maybeB64ToUtf8(titleText) : t("programme.untitled")
    const descText = readTextField(entry.description, entry.description_raw)
    const desc = descText ? maybeB64ToUtf8(descText) : ""

    const archiveFlag = entry.has_archive
    const programme: Programme = { start, stop, title, desc }
    if (archiveFlag !== undefined && archiveFlag !== null) {
      programme.hasArchive = Number(archiveFlag) === 1
    }
    programmes.push(programme)
  }
  programmes.sort((first, second) => first.start - second.start)
  return programmes
}

function xtreamApiOpts(creds: XtreamCreds) {
  return creds.entryId ? { entryId: creds.entryId } : {}
}

/** Fetches current + upcoming programmes for one live stream. Null on failure or an unavailable source. */
export async function fetchShortEpg(
  creds: XtreamCreds,
  streamId: string | number,
  limit: number = SHORT_EPG_LIMIT
): Promise<Programme[] | null> {
  if (!xtreamShortEpgAvailable(creds)) return null
  try {
    const response = await xtreamApiFetch(
      "get_short_epg",
      { stream_id: String(streamId), limit: String(limit) },
      xtreamApiOpts(creds)
    )
    if (!response.ok) return null
    const data = await response.json()
    const rows = Array.isArray(data?.epg_listings)
      ? data.epg_listings
      : Array.isArray(data)
      ? data
      : null
    if (!rows) return null
    return mapShortEpgRows(rows, Date.now())
  } catch {
    return null
  }
}

// Providers ship this action under both spellings; try each before giving up.
const FULL_TABLE_ACTIONS = ["get_simple_data_table", "get_simple_date_table"]

/** Fetches the full per-channel EPG timeline (past + future). Null on failure or an unavailable source. */
export async function fetchChannelEpgTable(
  creds: XtreamCreds,
  streamId: string | number
): Promise<Programme[] | null> {
  if (!xtreamShortEpgAvailable(creds)) return null
  const opts = xtreamApiOpts(creds)
  for (const action of FULL_TABLE_ACTIONS) {
    try {
      const response = await xtreamApiFetch(action, { stream_id: String(streamId) }, opts)
      if (!response.ok) continue
      const data = await response.json()
      if (!Array.isArray(data?.epg_listings)) continue
      return mapShortEpgRows(data.epg_listings, 0)
    } catch {
      continue
    }
  }
  return null
}

/** Cheap sync check: Xtream creds present and not an M3U-style source. */
export function xtreamShortEpgAvailable(creds: XtreamCreds | null | undefined): boolean {
  if (!creds || !creds.host || !creds.user || !creds.pass) return false
  return !isLikelyM3USource(creds.host, creds.user, creds.pass)
}

function pickNowNext(programmes: Programme[], atMs: number): ShortEpgNowNext {
  let current: Programme | null = null
  let next: Programme | null = null
  for (const programme of programmes) {
    if (programme.start <= atMs && atMs < programme.stop) {
      current = programme
    } else if (programme.start > atMs && (!next || programme.start < next.start)) {
      next = programme
    }
  }
  return { current, next }
}

interface CacheEntry {
  programmes: Programme[]
  expiresAt: number
}

export interface ShortEpgCacheOptions {
  fetchShortEpg?: typeof fetchShortEpg
  fetchChannelEpgTable?: typeof fetchChannelEpgTable
  now?: () => number
  maxEntries?: number
  concurrency?: number
  nowNextMaxTtlMs?: number
  programmesTtlMs?: number
  negativeTtlMs?: number
}

export interface ShortEpgCache {
  getNowNext(creds: XtreamCreds, streamId: string | number): Promise<ShortEpgNowNext | null>
  getProgrammes(creds: XtreamCreds, streamId: string | number): Promise<Programme[] | null>
  clear(): void
}

function credsIdentity(creds: XtreamCreds): string {
  return `${creds.entryId ?? ""}|${creds.host}|${creds.user}`
}

function buildCacheKey(kind: "nowNext" | "programmes", creds: XtreamCreds, streamId: string | number): string {
  return `${kind}:${credsIdentity(creds)}:${streamId}`
}

/**
 * Per-channel EPG cache: LRU-capped, per-entry TTL, in-flight dedupe, a
 * 4-way concurrency gate with a LIFO queue (newest scroll target wins), and a
 * short negative-result cache so a dead EPG endpoint isn't hammered.
 */
export function createShortEpgCache(options: ShortEpgCacheOptions = {}): ShortEpgCache {
  const loadShortEpg = options.fetchShortEpg ?? fetchShortEpg
  const loadChannelTable = options.fetchChannelEpgTable ?? fetchChannelEpgTable
  const now = options.now ?? (() => Date.now())
  const maxEntries = options.maxEntries ?? 64
  const concurrency = options.concurrency ?? 4
  const nowNextMaxTtlMs = options.nowNextMaxTtlMs ?? 15 * 60 * 1000
  const programmesTtlMs = options.programmesTtlMs ?? 15 * 60 * 1000
  const negativeTtlMs = options.negativeTtlMs ?? 60 * 1000

  const store = new Map<string, CacheEntry>()
  const negativeCache = new Map<string, number>()
  const inFlight = new Map<string, Promise<Programme[] | null>>()

  let active = 0
  const queue: Array<() => void> = []

  function drainQueue() {
    while (active < concurrency) {
      const job = queue.pop() // LIFO: the most recently requested channel runs first.
      if (!job) break
      job()
    }
  }

  function runThroughGate<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        active++
        task()
          .then(resolve, reject)
          .finally(() => {
            active--
            drainQueue()
          })
      })
      drainQueue()
    })
  }

  function touch(key: string, entry: CacheEntry) {
    store.delete(key)
    store.set(key, entry)
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value
      if (oldestKey === undefined) break
      store.delete(oldestKey)
    }
  }

  function readFresh(key: string): CacheEntry | null {
    const entry = store.get(key)
    if (!entry) return null
    if (now() >= entry.expiresAt) {
      store.delete(key)
      return null
    }
    store.delete(key)
    store.set(key, entry)
    return entry
  }

  function isNegative(key: string): boolean {
    const failedAt = negativeCache.get(key)
    if (failedAt === undefined) return false
    if (now() - failedAt >= negativeTtlMs) {
      negativeCache.delete(key)
      return false
    }
    return true
  }

  function loadInto(
    key: string,
    fetcher: () => Promise<Programme[] | null>,
    buildEntry: (programmes: Programme[]) => CacheEntry
  ): Promise<Programme[] | null> {
    const pending = inFlight.get(key)
    if (pending) return pending
    const promise = runThroughGate(async () => {
      try {
        return await fetcher()
      } catch {
        return null
      }
    }).then((programmes) => {
      inFlight.delete(key)
      if (!programmes) {
        negativeCache.set(key, now())
        return null
      }
      touch(key, buildEntry(programmes))
      return programmes
    })
    inFlight.set(key, promise)
    return promise
  }

  async function getNowNext(
    creds: XtreamCreds,
    streamId: string | number
  ): Promise<ShortEpgNowNext | null> {
    const key = buildCacheKey("nowNext", creds, streamId)
    if (isNegative(key)) return null
    const cached = readFresh(key)
    if (cached) return pickNowNext(cached.programmes, now())

    const programmes = await loadInto(key, () => loadShortEpg(creds, streamId), (result) => {
      const fetchedAtMs = now()
      const current = result.find(
        (programme) => programme.start <= fetchedAtMs && fetchedAtMs < programme.stop
      )
      const expiresAt = Math.min(current ? current.stop : Infinity, fetchedAtMs + nowNextMaxTtlMs)
      return { programmes: result, expiresAt }
    })
    return programmes ? pickNowNext(programmes, now()) : null
  }

  async function getProgrammes(
    creds: XtreamCreds,
    streamId: string | number
  ): Promise<Programme[] | null> {
    const key = buildCacheKey("programmes", creds, streamId)
    if (isNegative(key)) return null
    const cached = readFresh(key)
    if (cached) return cached.programmes

    return loadInto(key, () => loadChannelTable(creds, streamId), (result) => ({
      programmes: result,
      expiresAt: now() + programmesTtlMs,
    }))
  }

  function clear() {
    store.clear()
    negativeCache.clear()
    inFlight.clear()
  }

  return { getNowNext, getProgrammes, clear }
}
