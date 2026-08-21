// Shared cast-state feed: WebSocket push first, HTTP polling fallback, watchdog liveness check.
import {
  appendStreamedReceiverLog,
  getCastSession,
  sessionAsDevice,
  fetchCastState,
  fetchCastStateWithFallback,
  formatHostForUrl,
  parseCastStateValue,
  CAST_SESSION_EVENT,
  type CastSession,
  type CastState,
  type TvDevice,
} from "@/scripts/lib/tv-cast.js"
import { log } from "@/scripts/lib/log.js"

const FIRST_MESSAGE_TIMEOUT_MS = 3000
const WATCHDOG_POLL_MS = 15000
const WS_RETRY_MS = 30000
export const MAX_CONSECUTIVE_MISSES = 3

export interface CastFeedHealth {
  consecutiveMisses: number
  transport: "ws" | "poll"
}

interface Subscriber {
  cadenceMs: number
  listener: (state: CastState) => void
  onLost?: () => void
  onHealth?: (health: CastFeedHealth) => void
}

/** Effective poll cadence is the fastest cadence any active subscriber asked for. */
export function effectiveCadence(subscriberCadences: number[]): number {
  return subscriberCadences.length === 0 ? Infinity : Math.min(...subscriberCadences)
}

/** Parses one `/events` WebSocket text frame; same validation as the `/state` poll response. */
export function parseFeedMessage(raw: string): CastState | null {
  try {
    return parseCastStateValue(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Log frames are additive; state frames stay bare playback JSON for cross-version compat. */
export function parseLogFrame(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || (parsed as { kind?: unknown }).kind !== "log") return null
    const lines = (parsed as { lines?: unknown }).lines
    if (!Array.isArray(lines)) return null
    const usable = lines.filter((line): line is string => typeof line === "string")
    return usable.length > 0 ? usable : null
  } catch {
    return null
  }
}

export interface MissOutcome {
  count: number
  lost: boolean
}

/** Pure miss-counter transition: a hit resets to zero, a miss increments and flags giving up at maxMisses. */
export function nextMissState(current: number, hit: boolean, maxMisses = MAX_CONSECUTIVE_MISSES): MissOutcome {
  if (hit) return { count: 0, lost: false }
  const count = current + 1
  return { count, lost: count >= maxMisses }
}

type FeedMode = "idle" | "connecting" | "ws" | "poll"

const subscribers = new Map<number, Subscriber>()
let nextSubscriberId = 1
let documentListenersAttached = false

let boundSession: CastSession | null = null
let boundDevice: TvDevice | null = null
let mode: FeedMode = "idle"
let missCount = 0
let wsGeneration = 0
let ws: WebSocket | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let wsRetryTimer: ReturnType<typeof setTimeout> | null = null
let firstMessageTimer: ReturnType<typeof setTimeout> | null = null
let lastHealth: CastFeedHealth | null = null

function sessionKey(session: CastSession): string {
  return `${session.deviceId}:${session.host}:${session.port}:${session.key}`
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState !== "visible"
}

function emit(state: CastState): void {
  for (const subscriber of subscribers.values()) subscriber.listener(state)
}

function currentCadenceMs(): number {
  const cadence = effectiveCadence([...subscribers.values()].map((subscriber) => subscriber.cadenceMs))
  return Number.isFinite(cadence) ? cadence : WATCHDOG_POLL_MS
}

function clearFirstMessageTimer(): void {
  if (firstMessageTimer != null) {
    clearTimeout(firstMessageTimer)
    firstMessageTimer = null
  }
}

function clearWsRetryTimer(): void {
  if (wsRetryTimer != null) {
    clearTimeout(wsRetryTimer)
    wsRetryTimer = null
  }
}

function stopPollingLoop(): void {
  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function stopWatchdog(): void {
  if (watchdogTimer != null) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

function startPollingLoop(): void {
  stopPollingLoop()
  pollTimer = setInterval(() => void pollOnce(), currentCadenceMs())
}

function startWatchdog(): void {
  stopWatchdog()
  watchdogTimer = setInterval(() => void pollOnce(), WATCHDOG_POLL_MS)
}

async function pollOnce(): Promise<void> {
  if (!boundDevice || documentHidden()) return
  const nearGiveUp = missCount === MAX_CONSECUTIVE_MISSES - 1
  const state = nearGiveUp ? await fetchCastStateWithFallback(boundDevice) : await fetchCastState(boundDevice)
  registerOutcome(!!state)
  if (state) emit(state)
}

/** Broadcasts a health snapshot to subscribers only when it actually changed since the last emit. */
function emitHealthIfChanged(): void {
  if (mode !== "ws" && mode !== "poll") return
  const health: CastFeedHealth = { consecutiveMisses: missCount, transport: mode }
  if (lastHealth && lastHealth.consecutiveMisses === health.consecutiveMisses && lastHealth.transport === health.transport) {
    return
  }
  lastHealth = health
  for (const subscriber of subscribers.values()) subscriber.onHealth?.(health)
}

function registerOutcome(hit: boolean): void {
  const outcome = nextMissState(missCount, hit)
  missCount = outcome.count
  emitHealthIfChanged()
  if (!outcome.lost) return
  const lostSubscribers = [...subscribers.values()]
  unbind()
  subscribers.clear()
  for (const subscriber of lostSubscribers) subscriber.onLost?.()
}

function enterWsMode(): void {
  mode = "ws"
  stopPollingLoop()
  startWatchdog()
  emitHealthIfChanged()
}

function enterPollMode(): void {
  mode = "poll"
  stopWatchdog()
  startPollingLoop()
  emitHealthIfChanged()
}

function scheduleWsRetry(): void {
  clearWsRetryTimer()
  wsRetryTimer = setTimeout(() => {
    wsRetryTimer = null
    if (boundDevice) connectWebSocket(false)
  }, WS_RETRY_MS)
}

function onWsAttemptFailed(isInitial: boolean): void {
  ws = null
  enterPollMode()
  if (!isInitial) scheduleWsRetry()
}

function onWsDroppedMidSession(): void {
  ws = null
  enterPollMode()
  scheduleWsRetry()
}

function connectWebSocket(isInitial: boolean): void {
  if (!boundDevice) return
  const generation = ++wsGeneration
  const device = boundDevice
  let socket: WebSocket
  try {
    if (typeof WebSocket === "undefined") throw new Error("WebSocket unsupported")
    const url = `ws://${formatHostForUrl(device.host)}:${device.port}/events?key=${encodeURIComponent(device.key)}`
    socket = new WebSocket(url)
  } catch (err) {
    log.warn("[xt:cast-state-feed] WebSocket unavailable:", err)
    onWsAttemptFailed(isInitial)
    return
  }
  ws = socket
  mode = "connecting"
  let sawMessage = false
  clearFirstMessageTimer()
  firstMessageTimer = setTimeout(() => {
    if (generation !== wsGeneration || sawMessage) return
    log.warn("[xt:cast-state-feed] WebSocket first-message timeout")
    try {
      socket.close()
    } catch {}
    onWsAttemptFailed(isInitial)
  }, FIRST_MESSAGE_TIMEOUT_MS)

  socket.addEventListener("message", (event) => {
    if (generation !== wsGeneration) return
    const raw = typeof event.data === "string" ? event.data : ""
    const logLines = parseLogFrame(raw)
    if (logLines) {
      // Proves the socket works; the miss counter tracks state freshness, so leave it alone.
      if (!sawMessage) {
        sawMessage = true
        clearFirstMessageTimer()
        enterWsMode()
      }
      if (boundDevice) appendStreamedReceiverLog(boundDevice.name, logLines)
      return
    }
    const state = parseFeedMessage(raw)
    if (!state) return
    if (!sawMessage) {
      sawMessage = true
      clearFirstMessageTimer()
      enterWsMode()
    }
    registerOutcome(true)
    emit(state)
  })
  socket.addEventListener("error", () => {
    if (generation !== wsGeneration || sawMessage) return
    clearFirstMessageTimer()
    onWsAttemptFailed(isInitial)
  })
  socket.addEventListener("close", () => {
    if (generation !== wsGeneration) return
    if (!sawMessage) {
      clearFirstMessageTimer()
      onWsAttemptFailed(isInitial)
      return
    }
    onWsDroppedMidSession()
  })
}

function unbind(): void {
  wsGeneration++
  clearFirstMessageTimer()
  clearWsRetryTimer()
  stopPollingLoop()
  stopWatchdog()
  if (ws) {
    try {
      ws.close()
    } catch {}
  }
  ws = null
  boundSession = null
  boundDevice = null
  mode = "idle"
  missCount = 0
  lastHealth = null
}

function bindSession(session: CastSession): void {
  boundSession = session
  boundDevice = sessionAsDevice(session)
  missCount = 0
  connectWebSocket(true)
}

function syncToSession(): void {
  const session = getCastSession()
  if (!session) {
    if (boundSession) unbind()
    return
  }
  if (boundSession && sessionKey(boundSession) === sessionKey(session)) {
    boundSession = session
    return
  }
  unbind()
  bindSession(session)
}

function ensureDocumentListenersAttached(): void {
  if (documentListenersAttached || typeof document === "undefined") return
  documentListenersAttached = true
  document.addEventListener(CAST_SESSION_EVENT, syncToSession)
}

/** Subscribes to receiver playback state; returns an unsubscribe function. One shared transport per session. */
export function subscribeCastStateFeed(
  listener: (state: CastState) => void,
  opts: { cadenceMs: number; onLost?: () => void; onHealth?: (health: CastFeedHealth) => void }
): () => void {
  ensureDocumentListenersAttached()
  const id = nextSubscriberId++
  subscribers.set(id, { cadenceMs: opts.cadenceMs, listener, onLost: opts.onLost, onHealth: opts.onHealth })
  syncToSession()
  if (mode === "poll") startPollingLoop()
  return () => {
    subscribers.delete(id)
    if (subscribers.size === 0) {
      unbind()
    } else if (mode === "poll") {
      startPollingLoop()
    }
  }
}
