// Full-screen (mobile) / right-side-panel (desktop) remote control for an active cast session.
// Structural precedent: tv-device-dialog.ts / player-picker-dialog.ts.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import { formatPaddedHms } from "@/scripts/lib/format.js"
import { debounce } from "@/scripts/lib/debounce.js"
import { toast } from "@/scripts/lib/toast.js"
import { log } from "@/scripts/lib/log.js"
import {
  getCastSession,
  castPause,
  castResume,
  castSeek,
  castStop,
  castSetVolume,
  sessionAsDevice,
  getReceiverLogTail,
  CAST_SESSION_EVENT,
  type CastSession,
  type CastState,
} from "@/scripts/lib/tv-cast.js"
import { subscribeCastStateFeed, type CastFeedHealth } from "@/scripts/lib/tv-cast-state-feed.js"
import { castNeighbor, neighborAvailability, resolveNeighborAvailability } from "@/scripts/lib/tv-cast-next.js"
import {
  ICON_X,
  ICON_DEVICE_TV,
  ICON_PLAYER_PLAY,
  ICON_PLAYER_PAUSE,
  ICON_PLAYER_TRACK_PREV,
  ICON_PLAYER_TRACK_NEXT,
  ICON_REWIND_BACKWARD_10,
  ICON_REWIND_FORWARD_10,
  ICON_REWIND_BACKWARD_30,
  ICON_REWIND_FORWARD_30,
  ICON_VOLUME,
  ICON_VOLUME_OFF,
} from "@/scripts/lib/icons.js"

const DIALOG_ID = "tv-cast-remote"
const SEEK_STEP_SMALL_SECONDS = 10
const SEEK_STEP_LARGE_SECONDS = 30
const SEEK_SUPPRESS_MS = 2500
const VOLUME_DEBOUNCE_MS = 150

let dlg: HTMLDialogElement | null = null

function ensureDialog(): HTMLDialogElement | null {
  if (typeof document === "undefined") return null
  if (dlg && document.body.contains(dlg)) return dlg
  const existing = document.getElementById(DIALOG_ID)
  if (existing instanceof HTMLDialogElement) {
    dlg = existing
    return dlg
  }
  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 sm:inset-y-0 sm:start-auto sm:end-0 m-0",
    "w-screen sm:w-[26rem] h-dvh sm:h-full max-w-none sm:max-w-[26rem] max-h-none",
    "rounded-none sm:rounded-s-2xl border-0 sm:border-s sm:border-line",
    "bg-surface text-fg p-0 open:flex flex-col overflow-hidden backdrop:bg-black/60",
  ].join(" ")
  document.body.appendChild(node)
  dlg = node
  return dlg
}

function formatClock(seconds: number): string {
  return formatPaddedHms(Math.max(0, Math.floor(seconds)))
}

const TRANSPORT_BUTTON_CLASS =
  "min-h-11 min-w-11 grid place-items-center rounded-full text-fg-2 enabled:hover:bg-surface-2 enabled:hover:text-fg " +
  "enabled:focus-visible:bg-surface-2 disabled:opacity-40"

function buildSkeleton(dialog: HTMLDialogElement): void {
  dialog.innerHTML = `
    <div data-role="backdrop" class="relative shrink-0 h-56 sm:h-64 overflow-hidden bg-surface-2">
      <div data-role="backdrop-img" class="absolute inset-0 scale-110 bg-cover bg-center blur-2xl opacity-0"></div>
      <div class="absolute inset-0 bg-gradient-to-b from-black/10 to-surface"></div>
      <img data-role="artwork-img" alt="" class="hidden absolute inset-0 m-auto max-h-[65%] max-w-[65%] object-contain rounded-lg shadow-xl" />
      <span data-role="artwork-fallback" class="absolute inset-0 grid place-items-center text-fg-3" aria-hidden="true">${ICON_DEVICE_TV}</span>
      <button type="button" data-role="close" class="absolute top-3 end-3 min-h-11 min-w-11 grid place-items-center rounded-full bg-black/40 text-white hover:bg-black/60 focus-visible:bg-black/60"></button>
    </div>
    <div class="flex flex-col gap-5 p-5 sm:p-6 overflow-y-auto min-h-0 flex-1">
      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-1.5 text-sm text-fg-3">
          <span data-role="device-name" class="truncate"></span>
          <span aria-hidden="true">·</span>
          <span data-role="state" aria-live="polite"></span>
        </div>
        <h2 id="${DIALOG_ID}-title" data-role="title" class="text-lg font-semibold leading-tight tracking-tight line-clamp-2"></h2>
        <details data-role="error-log" class="hidden text-xs text-fg-3">
          <summary data-role="error-log-summary" class="cursor-pointer select-none"></summary>
          <div data-role="error-log-text" class="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug"></div>
        </details>
      </div>

      <div data-role="scrubber" class="flex flex-col gap-1.5">
        <input data-role="seek-range" type="range" min="0" max="0" step="1" value="0" class="w-full h-1.5 accent-accent cursor-pointer" />
        <div class="flex items-center justify-between text-xs tabular-nums text-fg-3">
          <span data-role="position-time"></span>
          <span data-role="duration-time"></span>
        </div>
      </div>

      <div data-role="metadata" class="hidden flex-col gap-2 text-fg-3">
        <div data-role="metadata-now-meta" class="hidden text-xs tabular-nums"></div>
        <div data-role="metadata-heading" class="hidden text-sm font-medium text-fg leading-tight line-clamp-1"></div>
        <button type="button" data-role="metadata-plot-btn" class="hidden block w-full text-start">
          <p data-role="metadata-plot" class="text-xs leading-snug line-clamp-3"></p>
        </button>
        <div data-role="metadata-next-row" class="hidden text-xs truncate"></div>
        <div data-role="metadata-genre-row" class="hidden text-xs"></div>
        <div data-role="metadata-cast-row" class="hidden text-xs"></div>
      </div>

      <div class="flex items-center justify-between gap-0.5">
        <button type="button" data-role="prev" class="${TRANSPORT_BUTTON_CLASS}">${ICON_PLAYER_TRACK_PREV}</button>
        <button type="button" data-role="back30" class="${TRANSPORT_BUTTON_CLASS}">${ICON_REWIND_BACKWARD_30}</button>
        <button type="button" data-role="back10" class="${TRANSPORT_BUTTON_CLASS}">${ICON_REWIND_BACKWARD_10}</button>
        <button type="button" data-role="playpause" class="min-h-14 min-w-14 grid place-items-center rounded-full bg-accent text-on-accent hover:brightness-110 focus-visible:brightness-110"></button>
        <button type="button" data-role="forward10" class="${TRANSPORT_BUTTON_CLASS}">${ICON_REWIND_FORWARD_10}</button>
        <button type="button" data-role="forward30" class="${TRANSPORT_BUTTON_CLASS}">${ICON_REWIND_FORWARD_30}</button>
        <button type="button" data-role="next" class="${TRANSPORT_BUTTON_CLASS}">${ICON_PLAYER_TRACK_NEXT}</button>
      </div>

      <div data-role="volume-row" class="hidden items-center gap-3">
        <button type="button" data-role="mute" class="shrink-0 min-h-11 min-w-11 grid place-items-center rounded-full text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2"></button>
        <input data-role="volume-range" type="range" min="0" max="1" step="0.05" value="1" class="flex-1 h-1.5 accent-accent cursor-pointer" />
      </div>

      <div class="flex flex-col gap-2 mt-auto pt-2">
        <button type="button" data-role="footer-open" class="btn hidden"></button>
        <button type="button" data-role="footer-stop" class="btn-danger"></button>
      </div>
    </div>
  `
}

interface RemoteRefs {
  close: HTMLButtonElement
  backdropImg: HTMLElement
  artworkImg: HTMLImageElement
  artworkFallback: HTMLElement
  deviceName: HTMLElement
  stateEl: HTMLElement
  title: HTMLElement
  errorLog: HTMLElement
  errorLogSummary: HTMLElement
  errorLogText: HTMLElement
  scrubber: HTMLElement
  seekRange: HTMLInputElement
  positionTime: HTMLElement
  durationTime: HTMLElement
  metadata: HTMLElement
  metadataNowMeta: HTMLElement
  metadataHeading: HTMLElement
  metadataPlotBtn: HTMLButtonElement
  metadataPlot: HTMLElement
  metadataNextRow: HTMLElement
  metadataGenreRow: HTMLElement
  metadataCastRow: HTMLElement
  prev: HTMLButtonElement
  back30: HTMLButtonElement
  back10: HTMLButtonElement
  playpause: HTMLButtonElement
  forward10: HTMLButtonElement
  forward30: HTMLButtonElement
  next: HTMLButtonElement
  volumeRow: HTMLElement
  mute: HTMLButtonElement
  volumeRange: HTMLInputElement
  footerOpen: HTMLButtonElement
  footerStop: HTMLButtonElement
}

function collectRefs(dialog: HTMLDialogElement): RemoteRefs {
  const query = <T extends HTMLElement>(role: string) => dialog.querySelector<T>(`[data-role="${role}"]`)!
  return {
    close: query<HTMLButtonElement>("close"),
    backdropImg: query("backdrop-img"),
    artworkImg: query<HTMLImageElement>("artwork-img"),
    artworkFallback: query("artwork-fallback"),
    deviceName: query("device-name"),
    stateEl: query("state"),
    title: query("title"),
    errorLog: query("error-log"),
    errorLogSummary: query("error-log-summary"),
    errorLogText: query("error-log-text"),
    scrubber: query("scrubber"),
    seekRange: query<HTMLInputElement>("seek-range"),
    positionTime: query("position-time"),
    durationTime: query("duration-time"),
    metadata: query("metadata"),
    metadataNowMeta: query("metadata-now-meta"),
    metadataHeading: query("metadata-heading"),
    metadataPlotBtn: query<HTMLButtonElement>("metadata-plot-btn"),
    metadataPlot: query("metadata-plot"),
    metadataNextRow: query("metadata-next-row"),
    metadataGenreRow: query("metadata-genre-row"),
    metadataCastRow: query("metadata-cast-row"),
    prev: query<HTMLButtonElement>("prev"),
    back30: query<HTMLButtonElement>("back30"),
    back10: query<HTMLButtonElement>("back10"),
    playpause: query<HTMLButtonElement>("playpause"),
    forward10: query<HTMLButtonElement>("forward10"),
    forward30: query<HTMLButtonElement>("forward30"),
    next: query<HTMLButtonElement>("next"),
    volumeRow: query("volume-row"),
    mute: query<HTMLButtonElement>("mute"),
    volumeRange: query<HTMLInputElement>("volume-range"),
    footerOpen: query<HTMLButtonElement>("footer-open"),
    footerStop: query<HTMLButtonElement>("footer-stop"),
  }
}

function applyLabels(refs: RemoteRefs): void {
  refs.close.innerHTML = ICON_X
  refs.close.setAttribute("aria-label", t("common.close"))
  refs.prev.setAttribute("aria-label", t("cast.remote.previous"))
  refs.next.setAttribute("aria-label", t("cast.remote.next"))
  refs.back30.setAttribute("aria-label", t("cast.pill.back30"))
  refs.forward30.setAttribute("aria-label", t("cast.pill.forward30"))
  refs.back10.setAttribute("aria-label", t("cast.remote.back10"))
  refs.forward10.setAttribute("aria-label", t("cast.remote.forward10"))
  refs.seekRange.setAttribute("aria-label", t("cast.remote.seek"))
  refs.volumeRange.setAttribute("aria-label", t("cast.remote.volume"))
  refs.footerStop.textContent = t("cast.pill.stop")
  refs.errorLogSummary.textContent = t("cast.remote.errorLogSummary")
}

function setPlayPauseIcon(refs: RemoteRefs, paused: boolean): void {
  refs.playpause.innerHTML = paused ? ICON_PLAYER_PLAY : ICON_PLAYER_PAUSE
  refs.playpause.setAttribute("aria-label", paused ? t("cast.pill.resume") : t("cast.pill.pause"))
  refs.playpause.dataset.paused = paused ? "true" : "false"
}

function setMuteIcon(refs: RemoteRefs, muted: boolean): void {
  refs.mute.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME
  refs.mute.setAttribute("aria-label", muted ? t("cast.remote.unmute") : t("cast.remote.mute"))
}

function applySession(refs: RemoteRefs, session: CastSession): void {
  refs.deviceName.textContent = session.deviceName
  refs.title.textContent = session.title || ""

  if (session.logo) {
    refs.backdropImg.style.backgroundImage = `url(${JSON.stringify(session.logo)})`
    refs.backdropImg.classList.remove("opacity-0")
    refs.artworkImg.src = session.logo
    refs.artworkImg.classList.remove("hidden")
    refs.artworkFallback.classList.add("hidden")
  } else {
    refs.backdropImg.style.backgroundImage = ""
    refs.backdropImg.classList.add("opacity-0")
    refs.artworkImg.removeAttribute("src")
    refs.artworkImg.classList.add("hidden")
    refs.artworkFallback.classList.remove("hidden")
  }

  refs.scrubber.classList.toggle("hidden", session.isLive)
  refs.back30.classList.toggle("hidden", session.isLive)
  refs.back10.classList.toggle("hidden", session.isLive)
  refs.forward10.classList.toggle("hidden", session.isLive)
  refs.forward30.classList.toggle("hidden", session.isLive)

  refs.footerOpen.classList.toggle("hidden", !session.contentHref)
  if (session.contentHref) {
    refs.footerOpen.textContent = t("cast.pill.openContent", { title: session.title || t("common.untitled") })
  }
}

function applyAvailability(refs: RemoteRefs, availability: { previous: boolean; next: boolean }): void {
  refs.prev.disabled = !availability.previous
  refs.next.disabled = !availability.next
}

function applyScrubberState(refs: RemoteRefs, state: CastState): void {
  const previousMax = Number(refs.seekRange.max)
  const duration = state.durationSeconds ?? (Number.isFinite(previousMax) ? previousMax : 0)
  refs.seekRange.max = String(Math.max(duration, 0))
  refs.seekRange.value = String(state.positionSeconds)
  refs.positionTime.textContent = formatClock(state.positionSeconds)
  refs.durationTime.textContent = state.durationSeconds != null ? formatClock(state.durationSeconds) : ""
}

function applyState(refs: RemoteRefs, state: CastState): void {
  if (state.state === "error") {
    refs.stateEl.textContent = state.error ? `${t("cast.pill.error")}: ${state.error}` : t("cast.pill.error")
  } else {
    refs.stateEl.textContent = state.state === "paused" ? t("cast.remote.statePaused") : t("cast.remote.statePlaying")
    setPlayPauseIcon(refs, state.state === "paused")
  }
  if (state.volume !== undefined) {
    refs.volumeRow.classList.remove("hidden")
    refs.volumeRow.classList.add("flex")
    refs.volumeRange.value = String(state.volume)
    setMuteIcon(refs, !!state.muted)
  }
}

/** Shows the receiver's last few log lines only while the cast is in the error state. */
function updateErrorLog(refs: RemoteRefs, session: CastSession): void {
  const lines = getReceiverLogTail(session.deviceName)
  if (!lines.length) {
    refs.errorLog.classList.add("hidden")
    return
  }
  refs.errorLogText.textContent = lines.join("\n")
  refs.errorLog.classList.remove("hidden")
}

function formatProgrammeTimeRange(startMs: number, stopMs: number): string {
  try {
    const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    return `${formatter.format(startMs)}–${formatter.format(stopMs)}`
  } catch {
    return ""
  }
}

function formatProgrammeStartTime(startMs: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(startMs)
  } catch {
    return ""
  }
}

/** Key for the on-screen content, so a same-content session patch skips the metadata refetch. */
function metadataKeyFor(session: CastSession): string {
  if (session.liveContext) {
    const { playlistId, channelIds, index } = session.liveContext
    return `live:${playlistId}:${channelIds[index]}`
  }
  if (session.seriesContext) {
    const { playlistId, seriesId, season, episodeNum } = session.seriesContext
    return `series:${playlistId}:${seriesId}:${season}:${episodeNum}`
  }
  if (session.vodContext) {
    const { playlistId, vodId } = session.vodContext
    return `vod:${playlistId}:${vodId}`
  }
  return ""
}

/** Finds the raw get_series_info episode record for a season/episode, across the array-or-season-keyed `episodes` shapes. */
function findRawSeriesEpisode(seriesInfo: unknown, season: number, episodeNum: number): any {
  const episodes = (seriesInfo as { episodes?: unknown } | null)?.episodes
  const matches = (episode: any, seasonFallback: string) =>
    Number(episode?.season ?? seasonFallback) === season && Number(episode?.episode_num) === episodeNum
  if (Array.isArray(episodes)) {
    return episodes.find((episode: any) => matches(episode, "1")) ?? null
  }
  if (episodes && typeof episodes === "object") {
    for (const [seasonKey, seasonEpisodes] of Object.entries(episodes as Record<string, unknown>)) {
      if (!Array.isArray(seasonEpisodes)) continue
      const found = seasonEpisodes.find((episode: any) => matches(episode, seasonKey))
      if (found) return found
    }
  }
  return null
}

function resetMetadata(refs: RemoteRefs): void {
  refs.metadata.classList.remove("flex")
  refs.metadata.classList.add("hidden")
  refs.metadataNowMeta.classList.add("hidden")
  refs.metadataNowMeta.textContent = ""
  refs.metadataHeading.classList.add("hidden")
  refs.metadataHeading.textContent = ""
  refs.metadataPlotBtn.classList.add("hidden")
  refs.metadataPlot.textContent = ""
  refs.metadataPlot.classList.add("line-clamp-3")
  refs.metadataNextRow.classList.add("hidden")
  refs.metadataNextRow.textContent = ""
  refs.metadataGenreRow.classList.add("hidden")
  refs.metadataGenreRow.textContent = ""
  refs.metadataCastRow.classList.add("hidden")
  refs.metadataCastRow.textContent = ""
}

function revealMetadata(refs: RemoteRefs): void {
  refs.metadata.classList.remove("hidden")
  refs.metadata.classList.add("flex")
}

/** Opens the remote overlay for the active cast session; a no-op when nothing is casting. */
export function openCastRemote(): void {
  const session = getCastSession()
  if (!session) return

  const dialogOrNull = ensureDialog()
  if (!dialogOrNull) return
  const dialog: HTMLDialogElement = dialogOrNull

  try {
    if (dialog.open) dialog.close()
  } catch {}

  buildSkeleton(dialog)
  const refs = collectRefs(dialog)
  applyLabels(refs)

  let currentSession = session
  let lastKnownPositionSeconds = 0
  let suppressPositionUntil = 0
  let lastKnownVolume = 1
  let lastKnownMuted = false
  let scrubbing = false

  applySession(refs, currentSession)
  applyAvailability(refs, neighborAvailability(currentSession))
  setPlayPauseIcon(refs, false)
  void resolveNeighborAvailability(currentSession).then((availability) => {
    applyAvailability(refs, availability)
  })

  let metadataToken = 0
  let lastMetadataKey = ""

  function device() {
    return sessionAsDevice(currentSession)
  }

  async function loadLiveMetadata(liveContext: NonNullable<CastSession["liveContext"]>, token: number): Promise<void> {
    try {
      const { getCached } = await import("@/scripts/lib/cache.js")
      const liveList = getCached(liveContext.playlistId, "live")?.data || []
      const channelId = liveContext.channelIds[liveContext.index]
      const channel = liveList.find((entry: any) => String(entry?.id) === String(channelId))
      if (!channel) return
      const { getProgrammesSync, getNowNextForChannel } = await import("@/scripts/lib/epg-data.js")
      const state = getProgrammesSync(liveContext.playlistId)
      if (!state) return
      const { current, next } = getNowNextForChannel(state.programmes, channel, liveContext.playlistId)
      if (token !== metadataToken || (!current && !next)) return
      if (current) {
        refs.metadataNowMeta.textContent = `${t("cast.remote.nowLabel")} · ${formatProgrammeTimeRange(current.start, current.stop)}`
        refs.metadataNowMeta.classList.remove("hidden")
        refs.metadataHeading.textContent = current.title || ""
        refs.metadataHeading.classList.remove("hidden")
        if (current.desc) {
          refs.metadataPlot.textContent = current.desc
          refs.metadataPlotBtn.classList.remove("hidden")
        }
      }
      if (next) {
        refs.metadataNextRow.textContent = `${t("cast.remote.nextLabel")}: ${next.title || ""} · ${formatProgrammeStartTime(next.start)}`
        refs.metadataNextRow.classList.remove("hidden")
      }
      revealMetadata(refs)
    } catch (err) {
      log.warn("[xt:tv-cast-remote] live metadata load failed:", err)
    }
  }

  async function loadSeriesMetadata(seriesContext: NonNullable<CastSession["seriesContext"]>, token: number): Promise<void> {
    try {
      const { requestSeriesInfo } = await import("@/scripts/lib/series-seasons.js")
      const seriesInfo = await requestSeriesInfo(seriesContext.playlistId, seriesContext.seriesId)
      if (!seriesInfo || token !== metadataToken) return
      const episode = findRawSeriesEpisode(seriesInfo, seriesContext.season, seriesContext.episodeNum)
      const plot =
        episode?.info?.plot ||
        episode?.info?.overview ||
        episode?.plot ||
        seriesInfo?.info?.plot ||
        seriesInfo?.info?.description ||
        ""
      refs.metadataHeading.textContent =
        t("detail.seasonShort", { n: seriesContext.season }) + t("detail.episodeShort", { n: seriesContext.episodeNum })
      refs.metadataHeading.classList.remove("hidden")
      if (plot) {
        refs.metadataPlot.textContent = plot
        refs.metadataPlotBtn.classList.remove("hidden")
      }
      revealMetadata(refs)
    } catch (err) {
      log.warn("[xt:tv-cast-remote] series metadata load failed:", err)
    }
  }

  async function loadVodMetadata(vodContext: NonNullable<CastSession["vodContext"]>, token: number): Promise<void> {
    try {
      const { xtreamApiFetch } = await import("@/scripts/lib/xtream-api.js")
      const response = await xtreamApiFetch(
        "get_vod_info",
        { vod_id: String(vodContext.vodId) },
        { entryId: vodContext.playlistId }
      )
      if (!response.ok) return
      const data = await response.json()
      if (token !== metadataToken) return
      const info = data?.info || data?.movie_data || {}
      const movieData = data?.movie_data || data?.info || {}
      const plot = movieData.plot || movieData.description || info.plot || info.description || ""
      const genre = movieData.genre || info.genre || ""
      const castNames = String(info.cast || info.actors || info.director || "")
        .split(",")
        .map((name: string) => name.trim())
        .filter(Boolean)
      if (plot) {
        refs.metadataPlot.textContent = plot
        refs.metadataPlotBtn.classList.remove("hidden")
      }
      if (genre) {
        refs.metadataGenreRow.textContent = `${t("cast.remote.genreLabel")}: ${genre}`
        refs.metadataGenreRow.classList.remove("hidden")
      }
      if (castNames.length) {
        refs.metadataCastRow.textContent = `${t("cast.remote.castLabel")}: ${castNames.join(", ")}`
        refs.metadataCastRow.classList.remove("hidden")
      }
      if (plot || genre || castNames.length) revealMetadata(refs)
    } catch (err) {
      log.warn("[xt:tv-cast-remote] vod metadata load failed:", err)
    }
  }

  function refreshMetadata(session: CastSession, force = false): void {
    const key = metadataKeyFor(session)
    if (!force && key === lastMetadataKey) return
    lastMetadataKey = key
    metadataToken += 1
    const token = metadataToken
    resetMetadata(refs)
    if (session.liveContext) void loadLiveMetadata(session.liveContext, token)
    else if (session.seriesContext) void loadSeriesMetadata(session.seriesContext, token)
    else if (session.vodContext) void loadVodMetadata(session.vodContext, token)
  }

  refreshMetadata(currentSession, true)

  const debouncedSetVolume = debounce((level: number, muted: boolean) => {
    castSetVolume(device(), level, muted).catch((err) => log.warn("[xt:tv-cast-remote] set volume failed:", err))
  }, VOLUME_DEBOUNCE_MS)

  function onFeedState(state: CastState): void {
    if (state.state === "idle") {
      settleClose()
      return
    }
    if (state.volume !== undefined) lastKnownVolume = state.volume
    if (state.muted !== undefined) lastKnownMuted = state.muted
    applyState(refs, state)
    if (state.state === "error") updateErrorLog(refs, currentSession)
    else refs.errorLog.classList.add("hidden")
    if (currentSession.isLive || scrubbing || Date.now() < suppressPositionUntil) return
    lastKnownPositionSeconds = state.positionSeconds
    applyScrubberState(refs, state)
  }

  function onFeedHealth(health: CastFeedHealth): void {
    if (health.consecutiveMisses > 0) refs.stateEl.textContent = t("cast.pill.reconnecting")
  }

  function onFeedLost(): void {
    try {
      if (dialog.open) dialog.close()
    } catch {}
  }

  const feedUnsubscribe = subscribeCastStateFeed(onFeedState, {
    cadenceMs: 1000,
    onLost: onFeedLost,
    onHealth: onFeedHealth,
  })

  function seekTo(seconds: number): void {
    const clamped = Math.max(0, seconds)
    lastKnownPositionSeconds = clamped
    suppressPositionUntil = Date.now() + SEEK_SUPPRESS_MS
    refs.seekRange.value = String(clamped)
    refs.positionTime.textContent = formatClock(clamped)
    castSeek(device(), clamped).catch((err) => log.warn("[xt:tv-cast-remote] seek failed:", err))
  }

  async function skipNeighbor(direction: 1 | -1): Promise<void> {
    const button = direction === 1 ? refs.next : refs.prev
    if (button.disabled) return
    button.disabled = true
    const ok = await castNeighbor(direction)
    if (!ok) toast({ title: t("cast.toast.failed", { device: currentSession.deviceName }) })
    button.disabled = false
  }

  function onSeekPointerDown(): void {
    scrubbing = true
  }

  function onSeekChange(): void {
    scrubbing = false
    seekTo(Number(refs.seekRange.value))
  }

  function onSeekInput(): void {
    refs.positionTime.textContent = formatClock(Number(refs.seekRange.value))
  }

  function onVolumeInput(): void {
    lastKnownVolume = Number(refs.volumeRange.value)
    lastKnownMuted = false
    setMuteIcon(refs, false)
    debouncedSetVolume(lastKnownVolume, false)
  }

  function onClick(event: Event): void {
    const target = event.target as HTMLElement | null
    if (!target) return

    if (target.closest('[data-role="close"]')) {
      settleClose()
      return
    }
    if (target.closest('[data-role="prev"]')) {
      void skipNeighbor(-1)
      return
    }
    if (target.closest('[data-role="next"]')) {
      void skipNeighbor(1)
      return
    }
    if (target.closest('[data-role="metadata-plot-btn"]')) {
      refs.metadataPlot.classList.toggle("line-clamp-3")
      return
    }
    if (target.closest('[data-role="playpause"]')) {
      const paused = refs.playpause.dataset.paused === "true"
      const action = paused ? castResume(device()) : castPause(device())
      action.catch((err) => log.warn("[xt:tv-cast-remote] pause/resume failed:", err))
      setPlayPauseIcon(refs, !paused)
      return
    }
    if (target.closest('[data-role="back30"]')) {
      seekTo(lastKnownPositionSeconds - SEEK_STEP_LARGE_SECONDS)
      return
    }
    if (target.closest('[data-role="forward30"]')) {
      seekTo(lastKnownPositionSeconds + SEEK_STEP_LARGE_SECONDS)
      return
    }
    if (target.closest('[data-role="back10"]')) {
      seekTo(lastKnownPositionSeconds - SEEK_STEP_SMALL_SECONDS)
      return
    }
    if (target.closest('[data-role="forward10"]')) {
      seekTo(lastKnownPositionSeconds + SEEK_STEP_SMALL_SECONDS)
      return
    }
    if (target.closest('[data-role="mute"]')) {
      lastKnownMuted = !lastKnownMuted
      setMuteIcon(refs, lastKnownMuted)
      debouncedSetVolume(lastKnownVolume, lastKnownMuted)
      return
    }
    if (target.closest('[data-role="footer-open"]')) {
      if (currentSession.contentHref) window.location.assign(currentSession.contentHref)
      settleClose()
      return
    }
    if (target.closest('[data-role="footer-stop"]')) {
      castStop(device())
        .then(() => toast({ title: t("cast.toast.stopped", { device: currentSession.deviceName }) }))
        .catch((err) => log.warn("[xt:tv-cast-remote] stop failed:", err))
      settleClose()
      return
    }
    if (target === dialog) settleClose()
  }

  function onSessionChanged(): void {
    const nextSession = getCastSession()
    if (!nextSession) {
      settleClose()
      return
    }
    currentSession = nextSession
    applySession(refs, currentSession)
    applyAvailability(refs, neighborAvailability(currentSession))
    void resolveNeighborAvailability(currentSession).then((availability) => {
      applyAvailability(refs, availability)
    })
    refreshMetadata(currentSession)
  }

  function onCancel(event: Event): void {
    event.preventDefault()
    settleClose()
  }

  function settleClose(): void {
    try {
      if (dialog.open) dialog.close()
    } catch {}
  }

  function onLocaleChange(): void {
    detach()
    settleClose()
    openCastRemote()
  }

  function detach(): void {
    feedUnsubscribe()
    dialog.removeEventListener("click", onClick)
    refs.seekRange.removeEventListener("pointerdown", onSeekPointerDown)
    refs.seekRange.removeEventListener("change", onSeekChange)
    refs.seekRange.removeEventListener("input", onSeekInput)
    refs.volumeRange.removeEventListener("input", onVolumeInput)
    dialog.removeEventListener("cancel", onCancel)
    dialog.removeEventListener("close", onClose)
    document.removeEventListener(CAST_SESSION_EVENT, onSessionChanged)
    document.removeEventListener(LOCALE_EVENT, onLocaleChange)
  }

  function onClose(): void {
    detach()
  }

  dialog.addEventListener("click", onClick)
  refs.seekRange.addEventListener("pointerdown", onSeekPointerDown)
  refs.seekRange.addEventListener("change", onSeekChange)
  refs.seekRange.addEventListener("input", onSeekInput)
  refs.volumeRange.addEventListener("input", onVolumeInput)
  dialog.addEventListener("cancel", onCancel)
  dialog.addEventListener("close", onClose)
  document.addEventListener(CAST_SESSION_EVENT, onSessionChanged)
  document.addEventListener(LOCALE_EVENT, onLocaleChange)

  try {
    dialog.showModal()
  } catch (err) {
    log.warn("[xt:tv-cast-remote] showModal failed:", err)
    detach()
    return
  }

  attachDialogSpatialNav(dialog, {
    defaultElement: `#${DIALOG_ID} [data-role="playpause"]`,
  })

  refs.playpause.focus()
}
