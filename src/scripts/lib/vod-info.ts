// Lazy vod_info resolver, mirroring series-seasons.ts's throttled series-info
// queue. Reuses the same vod_info_<id> cache entry the movie detail page persists.

import { getCached, setCached, hydrate } from "@/scripts/lib/cache.js"
import { xtreamApiFetch } from "@/scripts/lib/xtream-api.js"
import { getActiveEntry } from "@/scripts/lib/creds.js"
import { isAbortLikeError } from "@/scripts/lib/provider-fetch.js"
import { log } from "@/scripts/lib/log.js"

// Matches movies-detail.ts so the two share one cache entry per movie.
const VOD_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CONCURRENT = 3

function vodInfoKind(movieId: string | number): string {
  return `vod_info_${movieId}`
}

function getCachedVodInfo(playlistId: string, movieId: string | number): { cached: boolean; data: any } {
  if (!playlistId || movieId == null) return { cached: false, data: null }
  const hit = getCached(playlistId, vodInfoKind(movieId))
  if (!hit) return { cached: false, data: null }
  return { cached: true, data: hit.data }
}

type Job = () => Promise<void>
const _queue: Job[] = []
const _pending = new Map<string, Promise<any | null>>()
const _failed = new Set<string>()
let _active = 0

// Tracks every caller sharing one in-flight (playlistId, movieId) job, so the underlying
// network call only gets cancelled once every subscriber has bailed - a subscriber that
// never passed a signal counts as "never bails", keeping the job alive for it indefinitely.
interface PendingJob {
  controller: AbortController
  subscriberCount: number
  abortedSubscriberCount: number
  hasUnconditionalSubscriber: boolean
}
const _jobs = new Map<string, PendingJob>()

function maybeAbortJob(job: PendingJob): void {
  if (job.hasUnconditionalSubscriber) return
  if (job.abortedSubscriberCount < job.subscriberCount) return
  job.controller.abort()
}

/** Registers one more caller against `job`, aborting its shared controller once every
 * subscriber (that passed a signal) has aborted. Callers joining later are counted too. */
function attachJobSubscriber(job: PendingJob, signal?: AbortSignal): void {
  job.subscriberCount++
  if (!signal) {
    job.hasUnconditionalSubscriber = true
    return
  }
  if (signal.aborted) {
    job.abortedSubscriberCount++
    maybeAbortJob(job)
    return
  }
  signal.addEventListener(
    "abort",
    () => {
      job.abortedSubscriberCount++
      maybeAbortJob(job)
    },
    { once: true }
  )
}

function jobKey(playlistId: string, movieId: string | number): string {
  return `${playlistId}::${movieId}`
}

if (typeof document !== "undefined") {
  document.addEventListener("xt:active-changed", () => _failed.clear())
}

function pump(): void {
  while (_active < MAX_CONCURRENT && _queue.length) {
    const job = _queue.shift()!
    _active++
    job().finally(() => {
      _active--
      pump()
    })
  }
}

async function isActivePlaylist(playlistId: string): Promise<boolean> {
  try {
    const entry = await getActiveEntry()
    return !!entry && entry._id === playlistId
  } catch {
    return false
  }
}

async function fetchVodInfo(playlistId: string, movieId: string | number, signal?: AbortSignal): Promise<any | null> {
  try {
    const response = await xtreamApiFetch("get_vod_info", { vod_id: String(movieId) }, { signal })
    if (!response.ok) throw new Error(`get_vod_info ${response.status}`)
    const data = await response.json()
    if (!(await isActivePlaylist(playlistId))) return null
    setCached(playlistId, vodInfoKind(movieId), data, VOD_INFO_TTL_MS)
    return data
  } catch (err) {
    // A superseded hero request (focus moved to another card) isn't a real failure -
    // never poison the failed-set for it, or a later refocus would never retry.
    if (isAbortLikeError(err, signal)) return null
    _failed.add(jobKey(playlistId, movieId))
    log.warn(`[xt:vod-info] ${movieId} lookup failed:`, err)
    return null
  }
}

/**
 * Resolve the raw get_vod_info payload for one movie. Returns the cached
 * value immediately when available, otherwise queues a throttled fetch.
 * Resolves to null when unavailable (M3U source, network failure, or a
 * playlist switch mid-fetch).
 *
 * `signal` registers this call as one more subscriber of the shared in-flight job for
 * `(playlistId, movieId)` (starting one if none exists yet); the underlying network call
 * only aborts once every subscriber that passed a signal has aborted theirs, so one hero
 * generation moving on never cancels the fetch for another still-interested subscriber.
 */
export function requestVodInfo(
  playlistId: string,
  movieId: string | number,
  signal?: AbortSignal
): Promise<any | null> {
  if (!playlistId || movieId == null) return Promise.resolve(null)

  const cached = getCachedVodInfo(playlistId, movieId)
  if (cached.cached) return Promise.resolve(cached.data)
  const key = jobKey(playlistId, movieId)
  if (_failed.has(key)) return Promise.resolve(null)
  const existing = _pending.get(key)
  if (existing) {
    const existingJob = _jobs.get(key)
    if (existingJob) attachJobSubscriber(existingJob, signal)
    return existing
  }

  const job: PendingJob = {
    controller: new AbortController(),
    subscriberCount: 0,
    abortedSubscriberCount: 0,
    hasUnconditionalSubscriber: false,
  }
  _jobs.set(key, job)
  attachJobSubscriber(job, signal)

  const promise = new Promise<any | null>((resolve) => {
    _queue.push(async () => {
      if (!(await isActivePlaylist(playlistId))) {
        resolve(null)
        return
      }

      await hydrate(playlistId, vodInfoKind(movieId)).catch(() => {})
      const fromCache = getCachedVodInfo(playlistId, movieId)
      if (fromCache.cached) {
        resolve(fromCache.data)
        return
      }
      resolve(await fetchVodInfo(playlistId, movieId, job.controller.signal))
    })
    pump()
  }).finally(() => {
    _pending.delete(key)
    _jobs.delete(key)
  })

  _pending.set(key, promise)
  return promise
}
