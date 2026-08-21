// Ambient idle screensaver for the TV receiver: rotating artwork after inactivity.
import { buildAmbientManifest, type AmbientEntry, type AmbientTier } from "@/scripts/lib/ambient-manifest"
import { writeAmbientHandoff } from "@/scripts/lib/ambient-handoff"
import { log } from "@/scripts/lib/log.js"

export type ReceiverAmbientVisualState = "info" | "ambient"

export interface CastHistoryEntry {
  title: string
  logo: string
  at: number
}

const HTTP_URL_PATTERN = /^https?:\/\//i
const CAST_HISTORY_KEY = "xt_receiver_cast_history"
const CAST_HISTORY_CAP = 50
const PUSHED_MANIFEST_KEY = "xt_receiver_ambient_manifest"
const PUSHED_MANIFEST_CAP = 50
const PUSHED_MANIFEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const IDLE_TIMEOUT_MS = 90_000
const HOLD_MS = 25_000
const MANIFEST_REFRESH_MS = 30 * 60 * 1000
const MAX_ARTWORK_FAILURES = 2
const BURN_IN_INTERVAL_MS = 5 * 60 * 1000
const BURN_IN_MAX_PX = 8
const AMBIENT_ELIGIBLE_STATES = new Set(["idle", "ended", "error"])
const AMBIENT_TIERS = new Set<AmbientTier>(["watching", "recent", "recommended", "catalog"])

export function appendCastHistory(
  list: CastHistoryEntry[],
  entry: { title?: string; logo?: string },
  cap = CAST_HISTORY_CAP,
): CastHistoryEntry[] {
  const title = (entry.title || "").trim()
  const logo = (entry.logo || "").trim()
  if (!title || !HTTP_URL_PATTERN.test(logo)) return list
  const filtered = list.filter((item) => !(item.title === title && item.logo === logo))
  return [{ title, logo, at: Date.now() }, ...filtered].slice(0, cap)
}

export function castHistoryToAmbientEntries(history: CastHistoryEntry[]): AmbientEntry[] {
  return history.map((item, index) => ({
    kind: "vod",
    id: `history:${index}:${item.at}`,
    title: item.title,
    posterUrl: item.logo,
    backdropUrl: null,
    logoUrl: null,
    tier: "watching",
  }))
}

export function ambientEntryKey(entry: AmbientEntry): string {
  return `${entry.kind}:${entry.id}`
}

function sanitizePushedAmbientEntry(value: unknown): AmbientEntry | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (record.kind !== "vod" && record.kind !== "series") return null
  if (typeof record.id !== "string" || !record.id) return null
  if (typeof record.title !== "string" || !record.title.trim()) return null
  const posterUrl = typeof record.posterUrl === "string" && HTTP_URL_PATTERN.test(record.posterUrl) ? record.posterUrl : null
  const backdropUrl = typeof record.backdropUrl === "string" && HTTP_URL_PATTERN.test(record.backdropUrl) ? record.backdropUrl : null
  const logoUrl = typeof record.logoUrl === "string" && HTTP_URL_PATTERN.test(record.logoUrl) ? record.logoUrl : null
  if (!posterUrl && !backdropUrl && !logoUrl) return null
  const tier = AMBIENT_TIERS.has(record.tier as AmbientTier) ? (record.tier as AmbientTier) : "catalog"
  return { kind: record.kind, id: record.id, title: record.title, posterUrl, backdropUrl, logoUrl, tier }
}

/** Defensive shape validation for a manifest pushed over the network; caps the result too. */
export function sanitizePushedAmbientEntries(value: unknown, cap = PUSHED_MANIFEST_CAP): AmbientEntry[] {
  if (!Array.isArray(value)) return []
  const sanitized: AmbientEntry[] = []
  for (const item of value) {
    const entry = sanitizePushedAmbientEntry(item)
    if (entry) sanitized.push(entry)
    if (sanitized.length >= cap) break
  }
  return sanitized
}

export interface PushedAmbientManifest {
  at: number
  entries: AmbientEntry[]
}

export interface AmbientArtworkSources {
  libraryEntries: AmbientEntry[]
  pushedManifest: PushedAmbientManifest | null
  castHistoryEntries: AmbientEntry[]
  now?: number
}

/** Cascade: local library artwork, then a fresh sender-pushed manifest, then cast history. */
export function selectAmbientArtwork(sources: AmbientArtworkSources): AmbientEntry[] {
  if (sources.libraryEntries.length > 0) return sources.libraryEntries
  const pushed = sources.pushedManifest
  if (pushed && pushed.entries.length > 0) {
    const now = sources.now ?? Date.now()
    if (now - pushed.at < PUSHED_MANIFEST_MAX_AGE_MS) return pushed.entries
  }
  return sources.castHistoryEntries
}

export interface AmbientRenderModel {
  coverImageUrl: string
  posterUrl: string | null
  kenBurns: boolean
}

export function buildAmbientRenderModel(entry: AmbientEntry): AmbientRenderModel | null {
  if (entry.backdropUrl) {
    return { coverImageUrl: entry.backdropUrl, posterUrl: entry.posterUrl ?? null, kenBurns: true }
  }
  if (entry.posterUrl) return { coverImageUrl: entry.posterUrl, posterUrl: entry.posterUrl, kenBurns: false }
  return null
}

export function playableAmbientEntries(entries: AmbientEntry[]): AmbientEntry[] {
  return entries.filter((entry) => buildAmbientRenderModel(entry) !== null)
}

export function canEnterAmbient(playbackState: string, entries: AmbientEntry[]): boolean {
  return AMBIENT_ELIGIBLE_STATES.has(playbackState) && entries.length > 0
}

export type AmbientMode = "artwork" | "brand" | "none"

/** Idle-timer entry decision: rotate artwork, fall back to the brand mark, or stay on the pairing screen. */
export function resolveAmbientMode(playbackState: string, entries: AmbientEntry[]): AmbientMode {
  if (!AMBIENT_ELIGIBLE_STATES.has(playbackState)) return "none"
  return entries.length > 0 ? "artwork" : "brand"
}

export function nextRotationIndex(length: number, currentIndex: number): number {
  if (length <= 0) return 0
  return (currentIndex + 1) % length
}

export function recordArtworkFailure(
  failureCounts: Map<string, number>,
  key: string,
  maxFailures = MAX_ARTWORK_FAILURES,
): boolean {
  const count = (failureCounts.get(key) ?? 0) + 1
  failureCounts.set(key, count)
  return count >= maxFailures
}

function loadCastHistory(): CastHistoryEntry[] {
  try {
    const raw = localStorage.getItem(CAST_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is CastHistoryEntry =>
        !!item && typeof item.title === "string" && typeof item.logo === "string" && typeof item.at === "number",
    )
  } catch {
    return []
  }
}

function saveCastHistory(history: CastHistoryEntry[]): void {
  try {
    localStorage.setItem(CAST_HISTORY_KEY, JSON.stringify(history))
  } catch {}
}

function loadPushedManifest(): PushedAmbientManifest | null {
  try {
    const raw = localStorage.getItem(PUSHED_MANIFEST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || typeof parsed.at !== "number") return null
    const entries = sanitizePushedAmbientEntries(parsed.entries)
    return entries.length > 0 ? { at: parsed.at, entries } : null
  } catch {
    return null
  }
}

function savePushedManifest(entries: AmbientEntry[]): void {
  try {
    localStorage.setItem(PUSHED_MANIFEST_KEY, JSON.stringify({ at: Date.now(), entries }))
  } catch {}
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

function motionDisabled(): boolean {
  return document.documentElement.dataset.perfMode === "on" || prefersReducedMotion()
}

export interface ReceiverAmbientDom {
  root: HTMLElement | null
  idleEl: HTMLElement | null
  layerA: HTMLElement | null
  layerB: HTMLElement | null
  posterEl: HTMLImageElement | null
  logoEl: HTMLImageElement | null
  titleEl: HTMLElement | null
  addressEl: HTMLElement | null
  codeEl: HTMLElement | null
  foregroundEl: HTMLElement | null
  brandEl: HTMLElement | null
  brandMarkEl: HTMLElement | null
  lockupEl: HTMLElement | null
  clockEl: HTMLElement | null
}

export interface ReceiverAmbientDeps {
  dom: ReceiverAmbientDom
  getPlaylistId(): Promise<string | null>
}

export interface ReceiverAmbient {
  notifyPlaybackState(state: string): void
  noteCastDescriptor(descriptor: { title?: string; logo?: string }): void
  notePushedManifest(entries: unknown): void
  setPairingInfo(address: string, code: string): void
  destroy(): void
}

export function mountReceiverAmbient(deps: ReceiverAmbientDeps): ReceiverAmbient {
  const { dom } = deps
  let visualState: ReceiverAmbientVisualState = "info"
  let playbackState = "idle"
  let destroyed = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let rotationTimer: ReturnType<typeof setTimeout> | null = null

  let manifestEntries: AmbientEntry[] = []
  let libraryEntriesCache: AmbientEntry[] = []
  let lastManifestFetchAt = 0
  let rotationEntries: AmbientEntry[] = []
  let rotationIndex = -1
  let activeLayer: "a" | "b" = "a"
  let ambientMode: AmbientMode | null = null
  let lastLoggedBailReason: string | null = null
  let clockTimer: ReturnType<typeof setTimeout> | null = null
  const failureCounts = new Map<string, number>()

  function updateClockText(): void {
    if (dom.clockEl) dom.clockEl.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date())
  }

  function scheduleClockTick(): void {
    const now = new Date()
    const msToNextMinute = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds())
    clockTimer = setTimeout(() => {
      updateClockText()
      scheduleClockTick()
    }, msToNextMinute)
  }

  function startClock(): void {
    if (clockTimer) return
    updateClockText()
    scheduleClockTick()
  }

  function stopClock(): void {
    if (clockTimer) {
      clearTimeout(clockTimer)
      clockTimer = null
    }
  }

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function resetIdleTimer(): void {
    clearIdleTimer()
    idleTimer = setTimeout(() => { void attemptEnterAmbient() }, IDLE_TIMEOUT_MS)
  }

  function stopRotation(): void {
    if (rotationTimer) {
      clearTimeout(rotationTimer)
      rotationTimer = null
    }
  }

  async function fetchLibraryEntries(): Promise<AmbientEntry[]> {
    try {
      const playlistId = await deps.getPlaylistId()
      if (playlistId) return await buildAmbientManifest(playlistId)
    } catch (err) {
      log.warn("[xt:receiver-ambient] manifest build failed:", err)
    }
    return []
  }

  function recomputeManifestEntries(): void {
    manifestEntries = selectAmbientArtwork({
      libraryEntries: libraryEntriesCache,
      pushedManifest: loadPushedManifest(),
      castHistoryEntries: castHistoryToAmbientEntries(loadCastHistory()),
    })
    if (manifestEntries.length > 0) void writeAmbientHandoff(manifestEntries)
  }

  async function ensureManifestFresh(): Promise<void> {
    const now = Date.now()
    if (manifestEntries.length > 0 && now - lastManifestFetchAt < MANIFEST_REFRESH_MS) return
    lastManifestFetchAt = now
    libraryEntriesCache = await fetchLibraryEntries()
    recomputeManifestEntries()
  }

  function describeArtworkSourceCounts(): string {
    const pushedCount = loadPushedManifest()?.entries.length ?? 0
    const historyCount = loadCastHistory().length
    return `library=${libraryEntriesCache.length} pushed=${pushedCount} history=${historyCount}`
  }

  function logBailReasonIfChanged(): void {
    const reason = describeArtworkSourceCounts()
    if (reason === lastLoggedBailReason) return
    lastLoggedBailReason = reason
    log.info(`[xt:receiver-ambient] idle timeout with no playable artwork (${reason})`)
  }

  async function attemptEnterAmbient(): Promise<void> {
    if (destroyed || visualState === "ambient") return
    if (!AMBIENT_ELIGIBLE_STATES.has(playbackState)) return
    await ensureManifestFresh()
    const entries = playableAmbientEntries(manifestEntries)
    const mode = resolveAmbientMode(playbackState, entries)
    if (mode === "none") {
      resetIdleTimer()
      return
    }
    if (mode === "brand") {
      logBailReasonIfChanged()
      log.info("[xt:receiver-ambient] no artwork available, showing brand fallback")
      enterBrandAmbient()
      return
    }
    enterAmbient(entries)
  }

  function enterAmbient(entries: AmbientEntry[]): void {
    visualState = "ambient"
    ambientMode = "artwork"
    rotationEntries = entries
    rotationIndex = -1
    failureCounts.clear()
    lastLoggedBailReason = null
    log.info(`[xt:receiver-ambient] entering ambient: ${entries.length} entries`)
    dom.root?.setAttribute("data-active", "true")
    dom.root?.setAttribute("aria-hidden", "false")
    dom.idleEl?.setAttribute("data-ambient-active", "true")
    dom.brandEl?.classList.add("hidden")
    dom.lockupEl?.classList.remove("hidden")
    startClock()
    advanceRotation()
  }

  function enterBrandAmbient(): void {
    visualState = "ambient"
    ambientMode = "brand"
    stopRotation()
    dom.root?.setAttribute("data-active", "true")
    dom.root?.setAttribute("aria-hidden", "false")
    dom.idleEl?.setAttribute("data-ambient-active", "true")
    dom.layerA?.classList.remove("xt-ambient-layer-visible", "xt-ambient-kenburns")
    dom.layerB?.classList.remove("xt-ambient-layer-visible", "xt-ambient-kenburns")
    dom.posterEl?.classList.add("hidden")
    dom.logoEl?.classList.add("hidden")
    dom.titleEl?.classList.add("hidden")
    dom.brandMarkEl?.classList.toggle("xt-ambient-brand-breathe", !motionDisabled())
    dom.brandEl?.classList.remove("hidden")
    dom.lockupEl?.classList.add("hidden")
    startClock()
    scheduleBrandRecheck()
  }

  function scheduleBrandRecheck(): void {
    stopRotation()
    rotationTimer = setTimeout(() => { void recheckBrandAmbient() }, HOLD_MS)
  }

  async function recheckBrandAmbient(): Promise<void> {
    if (visualState !== "ambient" || ambientMode !== "brand") return
    await ensureManifestFresh()
    const entries = playableAmbientEntries(manifestEntries)
    if (entries.length > 0) {
      enterAmbient(entries)
      return
    }
    scheduleBrandRecheck()
  }

  function exitAmbient(): void {
    if (visualState !== "ambient") return
    visualState = "info"
    ambientMode = null
    stopRotation()
    dom.root?.setAttribute("data-active", "false")
    dom.root?.setAttribute("aria-hidden", "true")
    dom.idleEl?.removeAttribute("data-ambient-active")
    dom.brandEl?.classList.add("hidden")
    stopClock()
  }

  function dropEntry(entry: AmbientEntry): void {
    rotationEntries = rotationEntries.filter((candidate) => candidate !== entry)
  }

  function advanceRotation(): void {
    if (visualState !== "ambient") return
    if (rotationEntries.length === 0) {
      exitAmbient()
      resetIdleTimer()
      return
    }
    rotationIndex = nextRotationIndex(rotationEntries.length, rotationIndex)
    const entry = rotationEntries[rotationIndex]
    const model = buildAmbientRenderModel(entry)
    if (!model) {
      dropEntry(entry)
      rotationIndex = -1
      advanceRotation()
      return
    }
    preloadAndShow(entry, model)
  }

  function preloadAndShow(entry: AmbientEntry, model: AmbientRenderModel): void {
    const image = new Image()
    image.onload = () => {
      if (visualState !== "ambient") return
      renderEntry(entry, model)
      stopRotation()
      rotationTimer = setTimeout(advanceRotation, HOLD_MS)
    }
    image.onerror = () => {
      if (visualState !== "ambient") return
      log.warn(`[xt:receiver-ambient] artwork failed to load: ${model.coverImageUrl}`)
      if (recordArtworkFailure(failureCounts, ambientEntryKey(entry))) {
        dropEntry(entry)
        rotationIndex = -1
      }
      advanceRotation()
    }
    image.src = model.coverImageUrl
  }

  function renderEntry(entry: AmbientEntry, model: AmbientRenderModel): void {
    const showLayer = activeLayer === "a" ? dom.layerB : dom.layerA
    const hideLayer = activeLayer === "a" ? dom.layerA : dom.layerB
    activeLayer = activeLayer === "a" ? "b" : "a"

    if (showLayer) {
      showLayer.style.backgroundImage = `url("${model.coverImageUrl}")`
      showLayer.classList.toggle("xt-ambient-kenburns", model.kenBurns && !motionDisabled())
      showLayer.classList.add("xt-ambient-layer-visible")
    }
    hideLayer?.classList.remove("xt-ambient-layer-visible", "xt-ambient-kenburns")

    if (dom.posterEl) {
      if (model.posterUrl) {
        dom.posterEl.src = model.posterUrl
        dom.posterEl.classList.remove("hidden")
      } else {
        dom.posterEl.classList.add("hidden")
        dom.posterEl.removeAttribute("src")
      }
    }

    if (dom.logoEl && dom.titleEl) {
      if (entry.logoUrl) {
        dom.logoEl.src = entry.logoUrl
        dom.logoEl.classList.remove("hidden")
        dom.titleEl.classList.add("hidden")
      } else {
        dom.logoEl.classList.add("hidden")
        dom.logoEl.removeAttribute("src")
        dom.titleEl.classList.remove("hidden")
        dom.titleEl.textContent = entry.title
      }
    }
  }

  function onKeydownCapture(event: KeyboardEvent): void {
    if (visualState === "ambient") {
      event.preventDefault()
      event.stopPropagation()
      exitAmbient()
    }
    resetIdleTimer()
  }

  function onPointerWake(): void {
    if (visualState === "ambient") exitAmbient()
    resetIdleTimer()
  }

  document.addEventListener("keydown", onKeydownCapture, true)
  document.addEventListener("pointermove", onPointerWake)
  document.addEventListener("pointerdown", onPointerWake)

  function shiftForBurnIn(element: HTMLElement | null): void {
    if (!element) return
    const dx = Math.round((Math.random() - 0.5) * 2 * BURN_IN_MAX_PX)
    const dy = Math.round((Math.random() - 0.5) * 2 * BURN_IN_MAX_PX)
    element.style.transform = `translate(${dx}px, ${dy}px)`
  }

  const burnInInterval = setInterval(() => {
    if (visualState !== "ambient") return
    if (ambientMode === "brand") {
      // Brand fallback is fully static, so it shifts even in perf mode.
      shiftForBurnIn(dom.brandEl)
      return
    }
    if (motionDisabled()) return
    shiftForBurnIn(dom.foregroundEl)
  }, BURN_IN_INTERVAL_MS)

  resetIdleTimer()

  return {
    notifyPlaybackState(state: string): void {
      const previousState = playbackState
      playbackState = state
      if (!AMBIENT_ELIGIBLE_STATES.has(state)) {
        exitAmbient()
        clearIdleTimer()
        return
      }
      if (!AMBIENT_ELIGIBLE_STATES.has(previousState)) {
        lastLoggedBailReason = null
        resetIdleTimer()
      }
    },

    noteCastDescriptor(descriptor: { title?: string; logo?: string }): void {
      const existing = loadCastHistory()
      const updated = appendCastHistory(existing, descriptor)
      if (updated !== existing) saveCastHistory(updated)
    },

    notePushedManifest(entries: unknown): void {
      const rawCount = Array.isArray(entries) ? entries.length : 0
      const sanitized = sanitizePushedAmbientEntries(entries)
      log.info(`[xt:receiver-ambient] pushed manifest received: ${rawCount} entries, ${sanitized.length} kept`)
      if (sanitized.length === 0) return
      savePushedManifest(sanitized)
      recomputeManifestEntries()
      const playable = playableAmbientEntries(manifestEntries)
      if (visualState !== "ambient") return
      if (ambientMode === "brand" && playable.length > 0) {
        enterAmbient(playable)
      } else if (ambientMode === "artwork") {
        rotationEntries = playable
      }
    },

    setPairingInfo(address: string, code: string): void {
      if (dom.addressEl) dom.addressEl.textContent = address
      if (dom.codeEl) dom.codeEl.textContent = code
    },

    destroy(): void {
      destroyed = true
      clearIdleTimer()
      stopRotation()
      stopClock()
      clearInterval(burnInInterval)
      document.removeEventListener("keydown", onKeydownCapture, true)
      document.removeEventListener("pointermove", onPointerWake)
      document.removeEventListener("pointerdown", onPointerWake)
    },
  }
}
