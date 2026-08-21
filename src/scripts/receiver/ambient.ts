// Ambient idle screensaver for the TV receiver: rotating artwork after inactivity.
import { buildAmbientManifest, type AmbientEntry } from "@/scripts/lib/ambient-manifest"
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
const IDLE_TIMEOUT_MS = 90_000
const HOLD_MS = 25_000
const MANIFEST_REFRESH_MS = 30 * 60 * 1000
const MAX_ARTWORK_FAILURES = 2
const BURN_IN_INTERVAL_MS = 5 * 60 * 1000
const BURN_IN_MAX_PX = 8
const AMBIENT_ELIGIBLE_STATES = new Set(["idle", "ended", "error"])

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

export interface AmbientRenderModel {
  coverImageUrl: string
  posterUrl: string | null
  kenBurns: boolean
}

export function buildAmbientRenderModel(entry: AmbientEntry): AmbientRenderModel | null {
  if (entry.backdropUrl) return { coverImageUrl: entry.backdropUrl, posterUrl: null, kenBurns: true }
  if (entry.posterUrl) return { coverImageUrl: entry.posterUrl, posterUrl: entry.posterUrl, kenBurns: false }
  return null
}

export function playableAmbientEntries(entries: AmbientEntry[]): AmbientEntry[] {
  return entries.filter((entry) => buildAmbientRenderModel(entry) !== null)
}

export function canEnterAmbient(playbackState: string, entries: AmbientEntry[]): boolean {
  return AMBIENT_ELIGIBLE_STATES.has(playbackState) && entries.length > 0
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
}

export interface ReceiverAmbientDeps {
  dom: ReceiverAmbientDom
  getPlaylistId(): Promise<string | null>
}

export interface ReceiverAmbient {
  notifyPlaybackState(state: string): void
  noteCastDescriptor(descriptor: { title?: string; logo?: string }): void
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
  let lastManifestFetchAt = 0
  let rotationEntries: AmbientEntry[] = []
  let rotationIndex = -1
  let activeLayer: "a" | "b" = "a"
  const failureCounts = new Map<string, number>()

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

  async function loadArtworkEntries(): Promise<AmbientEntry[]> {
    try {
      const playlistId = await deps.getPlaylistId()
      if (playlistId) {
        const artwork = await buildAmbientManifest(playlistId)
        if (artwork.length > 0) return artwork
      }
    } catch (err) {
      log.warn("[xt:receiver-ambient] manifest build failed:", err)
    }
    return castHistoryToAmbientEntries(loadCastHistory())
  }

  async function ensureManifestFresh(): Promise<void> {
    const now = Date.now()
    if (manifestEntries.length > 0 && now - lastManifestFetchAt < MANIFEST_REFRESH_MS) return
    lastManifestFetchAt = now
    manifestEntries = await loadArtworkEntries()
  }

  async function attemptEnterAmbient(): Promise<void> {
    if (destroyed || visualState === "ambient") return
    if (!AMBIENT_ELIGIBLE_STATES.has(playbackState)) return
    await ensureManifestFresh()
    const entries = playableAmbientEntries(manifestEntries)
    if (!canEnterAmbient(playbackState, entries)) {
      resetIdleTimer()
      return
    }
    enterAmbient(entries)
  }

  function enterAmbient(entries: AmbientEntry[]): void {
    visualState = "ambient"
    rotationEntries = entries
    rotationIndex = -1
    failureCounts.clear()
    dom.root?.setAttribute("data-active", "true")
    dom.root?.setAttribute("aria-hidden", "false")
    dom.idleEl?.setAttribute("data-ambient-active", "true")
    advanceRotation()
  }

  function exitAmbient(): void {
    if (visualState !== "ambient") return
    visualState = "info"
    stopRotation()
    dom.root?.setAttribute("data-active", "false")
    dom.root?.setAttribute("aria-hidden", "true")
    dom.idleEl?.removeAttribute("data-ambient-active")
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

  const burnInInterval = setInterval(() => {
    if (visualState !== "ambient" || motionDisabled() || !dom.foregroundEl) return
    const dx = Math.round((Math.random() - 0.5) * 2 * BURN_IN_MAX_PX)
    const dy = Math.round((Math.random() - 0.5) * 2 * BURN_IN_MAX_PX)
    dom.foregroundEl.style.transform = `translate(${dx}px, ${dy}px)`
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
      if (!AMBIENT_ELIGIBLE_STATES.has(previousState)) resetIdleTimer()
    },

    noteCastDescriptor(descriptor: { title?: string; logo?: string }): void {
      const existing = loadCastHistory()
      const updated = appendCastHistory(existing, descriptor)
      if (updated !== existing) saveCastHistory(updated)
    },

    setPairingInfo(address: string, code: string): void {
      if (dom.addressEl) dom.addressEl.textContent = address
      if (dom.codeEl) dom.codeEl.textContent = code
    },

    destroy(): void {
      destroyed = true
      clearIdleTimer()
      stopRotation()
      clearInterval(burnInInterval)
      document.removeEventListener("keydown", onKeydownCapture, true)
      document.removeEventListener("pointermove", onPointerWake)
      document.removeEventListener("pointerdown", onPointerWake)
    },
  }
}
