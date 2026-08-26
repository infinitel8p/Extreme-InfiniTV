// Full-screen (mobile) / right-side-panel (desktop) remote control for an active cast session.
// Structural precedent: tv-device-dialog.ts / player-picker-dialog.ts.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import { formatElapsedSinceStart, formatPaddedHms } from "@/scripts/lib/format.js"
import { debounce } from "@/scripts/lib/debounce.js"
import { toast } from "@/scripts/lib/toast.js"
import { log } from "@/scripts/lib/log.js"
import {
  getCastSession,
  castPause,
  castResume,
  castSeek,
  castStop,
  castRetryLast,
  castSetVolume,
  isCastPlaySettling,
  sessionAsDevice,
  getReceiverLogTail,
  CAST_SESSION_EVENT,
  type CastSession,
  type CastState,
} from "@/scripts/lib/tv-cast.js"
import {
  subscribeCastStateFeed,
  pokeCastStateFeed,
  createIdleTeardownGuard,
  type CastFeedHealth,
} from "@/scripts/lib/tv-cast-state-feed.js"
import { castNeighbor, neighborAvailability, resolveNeighborAvailability } from "@/scripts/lib/tv-cast-next.js"
import type { CastPickerPanelHandle } from "@/scripts/lib/tv-cast-picker-panel.js"
import {
  ICON_X,
  ICON_DEVICE_TV,
  ICON_LIST_DETAILS,
  ICON_PLAYER_PLAY,
  ICON_PLAYER_PAUSE,
  ICON_PLAYER_TRACK_PREV,
  ICON_PLAYER_TRACK_NEXT,
  ICON_REWIND_BACKWARD_30,
  ICON_REWIND_FORWARD_30,
  ICON_VOLUME,
  ICON_VOLUME_OFF,
} from "@/scripts/lib/icons.js"

const DIALOG_ID = "tv-cast-remote"
const SEEK_STEP_LARGE_SECONDS = 30
const SEEK_SUPPRESS_MS = 2500
const VOLUME_DEBOUNCE_MS = 150
// Matches the pill's stop confirmation window, so the gesture feels identical on both surfaces.
const STOP_CONFIRM_WINDOW_MS = 3000

async function resolveActivePlaylistId(): Promise<string | null> {
  try {
    const { getActivePlaylistIdSync } = await import("@/scripts/lib/account-info.js")
    return getActivePlaylistIdSync() || null
  } catch {
    return null
  }
}

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
    <div data-role="page-now" class="relative flex min-h-0 flex-1 flex-col">
      <div data-role="wash" aria-hidden="true" class="xt-cast-wash pointer-events-none absolute inset-x-0 top-0 h-56"></div>

      <header class="relative shrink-0 flex items-start gap-3 ps-4 pe-2 pb-3 pt-[calc(1rem+env(safe-area-inset-top,0px))] short-viewport:pb-2 short-viewport:pt-[calc(0.5rem+env(safe-area-inset-top,0px))]">
        <span data-role="artwork" class="grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg bg-surface-2 text-fg-3 ring-1 ring-inset ring-line short-viewport:size-11">
          <img data-role="artwork-img" alt="" class="hidden h-full w-full object-contain" />
          <span data-role="artwork-fallback" aria-hidden="true">${ICON_DEVICE_TV}</span>
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <div class="flex items-center gap-1.5 text-xs text-fg-3">
            <span data-role="device-name" class="truncate"></span>
            <span aria-hidden="true">·</span>
            <span data-role="state" class="shrink-0" aria-live="polite"></span>
          </div>
          <h2 id="${DIALOG_ID}-title" data-role="title" class="text-base font-semibold leading-tight tracking-tight line-clamp-2"></h2>
        </div>
        <button type="button" data-role="close" class="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg"></button>
      </header>

      <div data-role="busy" class="hidden h-0.5 shrink-0 bg-line/40 dl-bar-indeterminate"></div>

      <div class="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4 short-viewport:gap-3">
        <div data-role="poster" class="hidden justify-center pt-1 short-viewport:!hidden">
          <img data-role="poster-img" alt="" class="max-h-[min(34dvh,13rem)] w-auto rounded-lg object-contain shadow-lg ring-1 ring-inset ring-line/60" />
        </div>

        <div data-role="error-block" class="hidden flex-col gap-2 rounded-lg border border-bad/40 bg-bad/5 p-3">
          <p data-role="error-line" role="alert" class="text-sm text-bad"></p>
          <button type="button" data-role="retry" class="self-start min-h-11 rounded-full px-3 text-xs font-semibold text-accent hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-60"></button>
          <details data-role="error-log" class="hidden text-xs text-fg-3">
            <summary data-role="error-log-summary" class="cursor-pointer select-none">
              <span data-role="error-log-summary-text"></span>
            </summary>
            <div data-role="error-log-text" class="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug"></div>
          </details>
        </div>

        <div data-role="metadata-skeleton" class="hidden flex-col gap-2" aria-hidden="true">
          <div class="h-2.5 w-24 rounded skel"></div>
          <div class="h-3 w-3/4 rounded skel"></div>
          <div class="h-2.5 w-full rounded skel"></div>
        </div>

        <div data-role="metadata" class="hidden flex-col gap-2 text-fg-3">
          <div data-role="metadata-now-meta" class="hidden text-xs tabular-nums"></div>
          <div data-role="metadata-heading" class="hidden text-sm font-medium leading-tight text-fg line-clamp-1"></div>
          <button type="button" data-role="metadata-plot-btn" class="hidden w-full text-start" aria-expanded="false">
            <p data-role="metadata-plot" class="text-xs leading-snug line-clamp-3"></p>
            <span data-role="metadata-plot-toggle" class="mt-0.5 inline-block text-xs font-medium text-accent"></span>
          </button>
          <div data-role="metadata-next-row" class="hidden truncate text-xs"></div>
          <div data-role="metadata-genre-row" class="hidden text-xs"></div>
        </div>

        <button type="button" data-role="picker-entry" class="hidden w-full min-h-12 items-center gap-3 rounded-lg border border-line px-3 text-start hover:bg-surface-2 focus-visible:bg-surface-2">
          <span class="shrink-0 text-fg-3" aria-hidden="true">${ICON_LIST_DETAILS}</span>
          <span data-role="picker-entry-label" class="flex-1 min-w-0 truncate text-sm"></span>
        </button>
      </div>

      <div class="relative flex shrink-0 flex-col gap-3 border-t border-line bg-surface px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] short-viewport:gap-2 short-viewport:pt-2">
        <div data-role="scrubber" class="flex flex-col gap-1.5">
          <input data-role="seek-range" type="range" min="0" max="0" step="1" value="0" class="h-1.5 w-full cursor-pointer accent-accent" />
          <div class="flex items-center justify-between text-xs tabular-nums text-fg-3">
            <span data-role="position-time"></span>
            <span data-role="duration-time"></span>
          </div>
        </div>

        <div data-role="live-elapsed" class="hidden items-center gap-1.5 text-xs text-fg-3">
          <span data-role="live-elapsed-label"></span>
          <span data-role="live-elapsed-value" class="tabular-nums"></span>
        </div>

        <div class="flex items-center justify-center gap-1 sm:gap-2">
          <button type="button" data-role="prev" class="${TRANSPORT_BUTTON_CLASS}">${ICON_PLAYER_TRACK_PREV}</button>
          <button type="button" data-role="back30" class="${TRANSPORT_BUTTON_CLASS}">${ICON_REWIND_BACKWARD_30}</button>
          <button type="button" data-role="playpause" class="mx-1 grid min-h-14 min-w-14 place-items-center rounded-full bg-accent text-on-accent hover:brightness-110 focus-visible:brightness-110"></button>
          <button type="button" data-role="forward30" class="${TRANSPORT_BUTTON_CLASS}">${ICON_REWIND_FORWARD_30}</button>
          <button type="button" data-role="next" class="${TRANSPORT_BUTTON_CLASS}">${ICON_PLAYER_TRACK_NEXT}</button>
        </div>

        <div data-role="volume-row" class="invisible flex items-center gap-3">
          <button type="button" data-role="mute" class="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2"></button>
          <input data-role="volume-range" type="range" min="0" max="1" step="0.05" value="1" class="h-1.5 flex-1 cursor-pointer accent-accent" />
        </div>

        <div class="flex flex-col gap-2 short-viewport:flex-row">
          <button type="button" data-role="footer-open" class="btn hidden short-viewport:flex-1"></button>
          <button type="button" data-role="footer-stop" class="btn-danger short-viewport:flex-1"></button>
        </div>
      </div>
    </div>

    <div data-role="page-channels" class="hidden min-h-0 flex-1 flex-col"></div>
  `
}

interface RemoteRefs {
  pageNow: HTMLElement
  pageChannels: HTMLElement
  wash: HTMLElement
  close: HTMLButtonElement
  artwork: HTMLElement
  artworkImg: HTMLImageElement
  artworkFallback: HTMLElement
  deviceName: HTMLElement
  stateEl: HTMLElement
  title: HTMLElement
  busy: HTMLElement
  errorBlock: HTMLElement
  errorLine: HTMLElement
  retry: HTMLButtonElement
  errorLog: HTMLElement
  errorLogSummaryText: HTMLElement
  errorLogText: HTMLElement
  metadataSkeleton: HTMLElement
  scrubber: HTMLElement
  seekRange: HTMLInputElement
  positionTime: HTMLElement
  durationTime: HTMLElement
  liveElapsed: HTMLElement
  liveElapsedLabel: HTMLElement
  liveElapsedValue: HTMLElement
  metadata: HTMLElement
  metadataNowMeta: HTMLElement
  metadataHeading: HTMLElement
  metadataPlotBtn: HTMLButtonElement
  metadataPlot: HTMLElement
  metadataPlotToggle: HTMLElement
  metadataNextRow: HTMLElement
  metadataGenreRow: HTMLElement
  poster: HTMLElement
  posterImg: HTMLImageElement
  pickerEntry: HTMLButtonElement
  pickerEntryLabel: HTMLElement
  prev: HTMLButtonElement
  back30: HTMLButtonElement
  playpause: HTMLButtonElement
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
    pageNow: query("page-now"),
    pageChannels: query("page-channels"),
    wash: query("wash"),
    close: query<HTMLButtonElement>("close"),
    artwork: query("artwork"),
    artworkImg: query<HTMLImageElement>("artwork-img"),
    artworkFallback: query("artwork-fallback"),
    deviceName: query("device-name"),
    stateEl: query("state"),
    title: query("title"),
    busy: query("busy"),
    errorBlock: query("error-block"),
    errorLine: query("error-line"),
    retry: query<HTMLButtonElement>("retry"),
    errorLog: query("error-log"),
    errorLogSummaryText: query("error-log-summary-text"),
    errorLogText: query("error-log-text"),
    metadataSkeleton: query("metadata-skeleton"),
    scrubber: query("scrubber"),
    seekRange: query<HTMLInputElement>("seek-range"),
    positionTime: query("position-time"),
    durationTime: query("duration-time"),
    liveElapsed: query("live-elapsed"),
    liveElapsedLabel: query("live-elapsed-label"),
    liveElapsedValue: query("live-elapsed-value"),
    metadata: query("metadata"),
    metadataNowMeta: query("metadata-now-meta"),
    metadataHeading: query("metadata-heading"),
    metadataPlotBtn: query<HTMLButtonElement>("metadata-plot-btn"),
    metadataPlot: query("metadata-plot"),
    metadataPlotToggle: query("metadata-plot-toggle"),
    metadataNextRow: query("metadata-next-row"),
    metadataGenreRow: query("metadata-genre-row"),
    poster: query("poster"),
    posterImg: query<HTMLImageElement>("poster-img"),
    pickerEntry: query<HTMLButtonElement>("picker-entry"),
    pickerEntryLabel: query("picker-entry-label"),
    prev: query<HTMLButtonElement>("prev"),
    back30: query<HTMLButtonElement>("back30"),
    playpause: query<HTMLButtonElement>("playpause"),
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
  refs.prev.setAttribute("aria-label", `${t("cast.remote.previous")} (P)`)
  refs.prev.title = `${t("cast.remote.previous")} (P)`
  refs.next.setAttribute("aria-label", `${t("cast.remote.next")} (N)`)
  refs.next.title = `${t("cast.remote.next")} (N)`
  refs.back30.setAttribute("aria-label", t("cast.pill.back30"))
  refs.back30.title = t("cast.pill.back30")
  refs.forward30.setAttribute("aria-label", t("cast.pill.forward30"))
  refs.forward30.title = t("cast.pill.forward30")
  refs.seekRange.setAttribute("aria-label", t("cast.remote.seek"))
  refs.volumeRange.setAttribute("aria-label", t("cast.remote.volume"))
  refs.footerStop.textContent = t("cast.pill.stop")
  refs.errorLogSummaryText.textContent = t("cast.remote.errorLogSummary")
  refs.retry.textContent = t("cast.pill.retry")
  refs.liveElapsedLabel.textContent = t("cast.remote.liveElapsedLabel")
  refs.metadataPlotToggle.textContent = t("cast.remote.plotMore")
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

/** Connected to a device but nothing chosen to play yet. */
function isConnectedOnlyRemoteSession(session: CastSession): boolean {
  return !!session.connectedOnly && !session.title
}

function applySession(refs: RemoteRefs, session: CastSession): void {
  refs.deviceName.textContent = session.deviceName
  // Never leave the heading empty: it is the dialog's accessible name.
  refs.title.textContent = session.title || t("cast.pill.connectedPrompt")

  // Posters and series artwork are content worth showing; a channel logo is not, so live
  // keeps the thumbnail. Short viewports never get the poster - the controls need the room.
  const wantsPoster = !!session.logo && !session.isLive && !!(session.vodContext || session.seriesContext)
  refs.poster.classList.toggle("hidden", !wantsPoster)
  refs.poster.classList.toggle("flex", wantsPoster)
  refs.artwork.classList.toggle("hidden", wantsPoster)
  refs.artwork.classList.toggle("short-viewport:grid", wantsPoster)
  if (wantsPoster) refs.posterImg.src = session.logo!
  else refs.posterImg.removeAttribute("src")

  refs.wash.classList.toggle("h-56", !wantsPoster)
  refs.wash.classList.toggle("h-[30rem]", wantsPoster)
  refs.wash.classList.toggle("short-viewport:h-40", wantsPoster)

  if (session.logo) {
    refs.wash.style.backgroundImage = `url(${JSON.stringify(session.logo)})`
    refs.wash.style.opacity = wantsPoster ? "0.32" : "0.22"
    refs.artworkImg.src = session.logo
    refs.artworkImg.classList.remove("hidden")
    refs.artworkFallback.classList.add("hidden")
  } else {
    refs.wash.style.backgroundImage = ""
    refs.wash.style.opacity = "0"
    refs.artworkImg.removeAttribute("src")
    refs.artworkImg.classList.add("hidden")
    refs.artworkFallback.classList.remove("hidden")
  }

  const connectedOnly = isConnectedOnlyRemoteSession(session)
  refs.scrubber.classList.toggle("hidden", session.isLive || connectedOnly)
  refs.back30.classList.toggle("hidden", session.isLive || connectedOnly)
  refs.forward30.classList.toggle("hidden", session.isLive || connectedOnly)
  refs.playpause.classList.toggle("hidden", connectedOnly)

  // "Next" is ambiguous on its own: name the thing it will move to.
  const previousLabel = session.seriesContext
    ? t("cast.remote.previousEpisode")
    : session.liveContext
      ? t("cast.remote.previousChannel")
      : t("cast.remote.previous")
  const nextLabel = session.seriesContext
    ? t("cast.remote.nextEpisode")
    : session.liveContext
      ? t("cast.remote.nextChannel")
      : t("cast.remote.next")
  refs.prev.setAttribute("aria-label", `${previousLabel} (P)`)
  refs.prev.title = `${previousLabel} (P)`
  refs.next.setAttribute("aria-label", `${nextLabel} (N)`)
  refs.next.title = `${nextLabel} (N)`

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

/** The receiver reports loading and buffering too; both mean "working on it", not "playing". */
function isBusyStateValue(stateValue: string): boolean {
  return stateValue === "loading" || stateValue === "buffering"
}

function stateLabel(state: CastState): string {
  if (isBusyStateValue(state.state)) return t("cast.remote.stateBuffering")
  return state.state === "paused" ? t("cast.remote.statePaused") : t("cast.remote.statePlaying")
}

function applyState(refs: RemoteRefs, state: CastState): void {
  if (state.state === "error") {
    refs.stateEl.textContent = t("cast.pill.error")
    refs.errorLine.textContent = state.error
      ? t("cast.remote.errorDetail", { detail: state.error })
      : t("cast.remote.errorGeneric")
    refs.errorBlock.classList.remove("hidden")
    refs.errorBlock.classList.add("flex")
  } else {
    refs.stateEl.textContent = stateLabel(state)
    refs.errorBlock.classList.add("hidden")
    refs.errorBlock.classList.remove("flex")
    if (!isBusyStateValue(state.state)) setPlayPauseIcon(refs, state.state === "paused")
  }
  if (state.volume !== undefined) {
    refs.volumeRow.classList.remove("invisible")
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

/** Resolves the stored creds for a playlist id, not just the currently active one. */
async function resolvePlaylistCreds(
  playlistId: string
): Promise<{ host: string; port: string; user: string; pass: string } | null> {
  const { getEntries, entryToCreds } = await import("@/scripts/lib/creds.js")
  const entry = (await getEntries()).find((candidate: any) => candidate._id === playlistId)
  return entry ? entryToCreds(entry) : null
}

/** Sets the plot and offers More/Less only when the 3-line clamp actually hides something. */
function applyPlot(refs: RemoteRefs, text: string): void {
  refs.metadataPlot.textContent = text
  refs.metadataPlot.classList.add("line-clamp-3")
  refs.metadataPlotBtn.classList.remove("hidden")
  refs.metadataPlotBtn.setAttribute("aria-expanded", "false")
  refs.metadataPlotToggle.textContent = t("cast.remote.plotMore")
  refs.metadataPlotToggle.classList.add("hidden")
  refs.metadataPlotBtn.disabled = true
  const measure = () => {
    const clamped = refs.metadataPlot.scrollHeight - refs.metadataPlot.clientHeight > 1
    refs.metadataPlotToggle.classList.toggle("hidden", !clamped)
    refs.metadataPlotBtn.disabled = !clamped
  }
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(measure)
  else measure()
}

function showMetadataSkeleton(refs: RemoteRefs, on: boolean): void {
  refs.metadataSkeleton.classList.toggle("hidden", !on)
  refs.metadataSkeleton.classList.toggle("flex", on)
}

function resetMetadata(refs: RemoteRefs): void {
  refs.metadata.classList.remove("flex")
  refs.metadata.classList.add("hidden")
  refs.metadataPlotBtn.setAttribute("aria-expanded", "false")
  refs.metadataPlotToggle.textContent = t("cast.remote.plotMore")
  refs.metadataNowMeta.classList.add("hidden")
  refs.metadataNowMeta.textContent = ""
  refs.metadataHeading.classList.add("hidden")
  refs.metadataHeading.textContent = ""
  refs.metadataPlotBtn.classList.add("hidden")
  refs.metadataPlotBtn.disabled = true
  refs.metadataPlotToggle.classList.add("hidden")
  refs.metadataPlot.textContent = ""
  refs.metadataPlot.classList.add("line-clamp-3")
  refs.metadataNextRow.classList.add("hidden")
  refs.metadataNextRow.textContent = ""
  refs.metadataGenreRow.classList.add("hidden")
  refs.metadataGenreRow.textContent = ""
}

function revealMetadata(refs: RemoteRefs): void {
  showMetadataSkeleton(refs, false)
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
  let liveElapsedTicker: ReturnType<typeof setInterval> | null = null
  let stopArmed = false
  let stopArmTimeout: ReturnType<typeof setTimeout> | null = null
  let retryInFlight = false
  let channelPanel: CastPickerPanelHandle | null = null
  let pickerKind: "channels" | "episodes" | null = null
  let panelOpen = false
  const idleTeardownGuard = createIdleTeardownGuard()

  function setBusy(busy: boolean): void {
    refs.busy.classList.toggle("hidden", !busy)
  }

  /** Channel id currently on the receiver, for the panel's now-playing accent. */
  function playingChannelId(): string | null {
    const context = currentSession.liveContext
    return context ? context.channelIds[context.index] ?? null : null
  }

  function clearStopArmTimeout(): void {
    if (stopArmTimeout != null) {
      clearTimeout(stopArmTimeout)
      stopArmTimeout = null
    }
  }

  function disarmStop(): void {
    clearStopArmTimeout()
    if (!stopArmed) return
    stopArmed = false
    refs.footerStop.textContent = t("cast.pill.stop")
    refs.footerStop.removeAttribute("aria-describedby")
  }

  /** Same two-press guard the pill uses, so one destructive action behaves the same on both surfaces. */
  function armStop(): void {
    stopArmed = true
    refs.footerStop.textContent = t("cast.pill.stopConfirmLabel")
    clearStopArmTimeout()
    stopArmTimeout = setTimeout(disarmStop, STOP_CONFIRM_WINDOW_MS)
  }

  function onStopPressed(): void {
    if (!stopArmed) {
      armStop()
      return
    }
    disarmStop()
    castStop(device())
      .then(() => toast({ title: t("cast.toast.stopped", { device: currentSession.deviceName }) }))
      .catch((err) => log.warn("[xt:tv-cast-remote] stop failed:", err))
    settleClose()
  }

  async function onRetryPressed(): Promise<void> {
    if (retryInFlight) return
    retryInFlight = true
    refs.retry.disabled = true
    setBusy(true)
    try {
      const ok = await castRetryLast(device())
      if (!ok) toast({ title: t("cast.toast.failed", { device: currentSession.deviceName }) })
      else pokeCastStateFeed()
    } catch (err) {
      log.warn("[xt:tv-cast-remote] retry failed:", err)
    } finally {
      retryInFlight = false
      refs.retry.disabled = false
    }
  }

  /** Live gets a channel list, a series gets its episodes, a single movie gets nothing to pick from. */
  async function resolvePickerKind(): Promise<"channels" | "episodes" | null> {
    if (currentSession.seriesContext) return "episodes"
    if (currentSession.vodContext && !currentSession.isLive) return null
    // A live session is proof enough; only a cold session has to consult the catalog cache.
    if (currentSession.liveContext) return "channels"
    const playlistId = await resolveActivePlaylistId()
    if (!playlistId) return null
    try {
      const { readCachedLiveChannels } = await import("@/scripts/lib/live-catalog.ts")
      return readCachedLiveChannels(playlistId).length ? "channels" : null
    } catch {
      return null
    }
  }

  async function syncPickerEntry(): Promise<void> {
    const kind = await resolvePickerKind()
    if (kind !== pickerKind) {
      pickerKind = kind
      // The mounted panel belongs to the previous kind; drop it so the next open rebuilds.
      channelPanel?.destroy()
      channelPanel = null
    }
    const label = kind === "episodes" ? t("detail.section.episodes") : t("cast.remote.channels")
    refs.pickerEntryLabel.textContent = label
    refs.pickerEntry.title = `${label} (C)`
    refs.pickerEntry.classList.toggle("hidden", !kind)
    refs.pickerEntry.classList.toggle("flex", !!kind)
  }

  function showChannelsPage(show: boolean): void {
    panelOpen = show
    refs.pageNow.classList.toggle("hidden", show)
    refs.pageNow.classList.toggle("flex", !show)
    refs.pageChannels.classList.toggle("hidden", !show)
    refs.pageChannels.classList.toggle("flex", show)
  }

  /** "<season>:<episode>" for the episode picker's now-playing accent. */
  function playingEpisodeId(): string | null {
    const context = currentSession.seriesContext
    return context ? `${context.season}:${context.episodeNum}` : null
  }

  async function buildPickerSource() {
    const { createChannelPickerSource, createEpisodePickerSource } = await import(
      "@/scripts/lib/tv-cast-picker-sources.js"
    )
    if (pickerKind === "episodes" && currentSession.seriesContext) {
      const { playlistId, seriesId } = currentSession.seriesContext
      return createEpisodePickerSource({ playlistId, seriesId, getPlayingEpisodeId: playingEpisodeId })
    }
    const playlistId = currentSession.liveContext?.playlistId || (await resolveActivePlaylistId())
    if (!playlistId) return null
    return createChannelPickerSource({ playlistId, getPlayingChannelId: playingChannelId })
  }

  async function openChannelsPanel(): Promise<void> {
    if (!pickerKind) return
    disarmStop()
    if (!channelPanel) {
      const source = await buildPickerSource()
      if (!source) return
      const { mountCastPickerPanel } = await import("@/scripts/lib/tv-cast-picker-panel.js")
      channelPanel = mountCastPickerPanel(refs.pageChannels, {
        source,
        onBack: () => closeChannelsPanel(),
        onTuneStart: () => setBusy(true),
        onTuneEnd: (ok) => {
          setBusy(false)
          if (ok) closeChannelsPanel()
        },
      })
    }
    showChannelsPage(true)
    channelPanel.focusFirst()
  }

  function closeChannelsPanel(): void {
    if (!panelOpen) return
    showChannelsPage(false)
    channelPanel?.reset()
    channelPanel?.refreshNowPlaying()
    const focusTarget = refs.playpause.classList.contains("hidden") ? refs.pickerEntry : refs.playpause
    focusTarget.focus()
  }

  function stopLiveElapsedTicker(): void {
    if (liveElapsedTicker != null) {
      clearInterval(liveElapsedTicker)
      liveElapsedTicker = null
    }
  }

  function renderLiveElapsed(session: CastSession): void {
    if (!session.isLive || session.startedAtMs == null) {
      refs.liveElapsed.classList.add("hidden")
      refs.liveElapsed.classList.remove("flex")
      return
    }
    refs.liveElapsedValue.textContent = formatElapsedSinceStart(session.startedAtMs, Date.now())
    refs.liveElapsed.classList.remove("hidden")
    refs.liveElapsed.classList.add("flex")
  }

  /** Ticks the live elapsed clock only while playing; a paused/buffering/reconnecting state freezes it. */
  function updateLiveElapsedTicking(playbackSession: CastSession, playing: boolean): void {
    renderLiveElapsed(playbackSession)
    const shouldTick = playing && playbackSession.isLive && playbackSession.startedAtMs != null
    if (!shouldTick) {
      stopLiveElapsedTicker()
      return
    }
    if (liveElapsedTicker != null) return
    liveElapsedTicker = setInterval(() => renderLiveElapsed(currentSession), 1000)
  }

  applySession(refs, currentSession)
  applyAvailability(refs, neighborAvailability(currentSession))
  setPlayPauseIcon(refs, false)
  setMuteIcon(refs, false)
  updateLiveElapsedTicking(currentSession, true)
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
      const { readCachedLiveChannels } = await import("@/scripts/lib/live-catalog.ts")
      const channelId = liveContext.channelIds[liveContext.index]
      let liveList: any[] = readCachedLiveChannels(liveContext.playlistId)
      let channel = liveList.find((entry: any) => String(entry?.id) === String(channelId))
      if (!channel) {
        const creds = await resolvePlaylistCreds(liveContext.playlistId)
        if (!creds || token !== metadataToken) return
        const { ensureLive } = await import("@/scripts/lib/catalog.js")
        liveList = await ensureLive(creds, liveContext.playlistId)
        if (token !== metadataToken) return
        channel = liveList.find((entry: any) => String(entry?.id) === String(channelId))
        if (!channel) return
      }
      const { getProgrammesSync, getNowNextForChannel, loadProgrammes } = await import("@/scripts/lib/epg-data.js")
      let state = getProgrammesSync(liveContext.playlistId)
      if (!state) {
        const creds = await resolvePlaylistCreds(liveContext.playlistId)
        if (!creds || token !== metadataToken) return
        state = await loadProgrammes(liveContext.playlistId, creds)
        if (token !== metadataToken || !state) return
      }
      const { current, next } = getNowNextForChannel(state.programmes, channel, liveContext.playlistId)
      if (token !== metadataToken || (!current && !next)) return
      if (current) {
        refs.metadataNowMeta.textContent = `${t("cast.remote.nowLabel")} · ${formatProgrammeTimeRange(current.start, current.stop)}`
        refs.metadataNowMeta.classList.remove("hidden")
        refs.metadataHeading.textContent = current.title || ""
        refs.metadataHeading.classList.remove("hidden")
        if (current.desc) applyPlot(refs, current.desc)
      }
      if (next) {
        refs.metadataNextRow.textContent = `${t("cast.remote.nextLabel")}: ${next.title || ""} · ${formatProgrammeStartTime(next.start)}`
        refs.metadataNextRow.classList.remove("hidden")
      }
      const group = channel.category || (Array.isArray(channel.categories) ? channel.categories[0] : "")
      if (group) {
        refs.metadataGenreRow.textContent = `${t("cast.remote.groupLabel")}: ${group}`
        refs.metadataGenreRow.classList.remove("hidden")
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
      if (token !== metadataToken) return

      const episodeShortLabel =
        t("detail.seasonShort", { n: seriesContext.season }) + t("detail.episodeShort", { n: seriesContext.episodeNum })
      const episode = seriesInfo ? findRawSeriesEpisode(seriesInfo, seriesContext.season, seriesContext.episodeNum) : null
      const seriesInfoRecord = seriesInfo?.info || {}
      const providerEpisodeTitle = episode?.title || ""
      let providerPlot = episode?.info?.plot || episode?.info?.overview || episode?.plot || ""

      refs.metadataNowMeta.textContent = episodeShortLabel
      refs.metadataNowMeta.classList.remove("hidden")
      refs.metadataHeading.textContent = providerEpisodeTitle || episodeShortLabel
      refs.metadataHeading.classList.remove("hidden")
      if (providerPlot) applyPlot(refs, providerPlot)
      revealMetadata(refs)

      const { resolveTmdbId, fetchSeasonEnrichment } = await import("@/scripts/lib/tmdb-enrich.ts")
      const providerTmdbId = Number(seriesInfoRecord.tmdb || seriesInfoRecord.tmdb_id) || null
      const tmdbId = await resolveTmdbId(seriesContext.playlistId, "series", {
        id: seriesContext.seriesId,
        name: seriesInfoRecord.name || seriesInfoRecord.title || currentSession.title || "",
        year: seriesInfoRecord.releaseDate || seriesInfoRecord.releasedate || seriesInfoRecord.year || null,
        providerTmdbId,
      })
      if (token !== metadataToken || tmdbId == null) return

      const { providerSeasonsFromEpisodeMap } = await import("@/scripts/lib/tmdb-season-map.ts")
      const seasonEnrichment = await fetchSeasonEnrichment(tmdbId, seriesContext.season, {
        providerSeasons: providerSeasonsFromEpisodeMap(seriesInfo?.episodes),
      })
      if (token !== metadataToken) return

      const tmdbEpisode = seasonEnrichment?.episodes.find(
        (candidate) => candidate.episodeNumber === seriesContext.episodeNum
      )
      if (!providerEpisodeTitle && tmdbEpisode?.name) {
        refs.metadataHeading.textContent = tmdbEpisode.name
      }
      if (!providerPlot) {
        providerPlot = tmdbEpisode?.overview || seriesInfoRecord.plot || seriesInfoRecord.description || ""
        if (providerPlot) applyPlot(refs, providerPlot)
      }
      revealMetadata(refs)
    } catch (err) {
      log.warn("[xt:tv-cast-remote] series metadata load failed:", err)
    }
  }

  async function loadVodMetadata(vodContext: NonNullable<CastSession["vodContext"]>, token: number): Promise<void> {
    let info: any = {}
    let movieData: any = {}
    try {
      const { xtreamApiFetch } = await import("@/scripts/lib/xtream-api.js")
      const response = await xtreamApiFetch(
        "get_vod_info",
        { vod_id: String(vodContext.vodId) },
        { entryId: vodContext.playlistId }
      )
      if (response.ok) {
        const data = await response.json()
        info = data?.info || data?.movie_data || {}
        movieData = data?.movie_data || data?.info || {}
      }
    } catch (err) {
      log.warn("[xt:tv-cast-remote] vod provider info load failed:", err)
    }
    if (token !== metadataToken) return

    let plot = movieData.plot || movieData.description || info.plot || info.description || ""
    let genre = movieData.genre || info.genre || ""

    if (plot) applyPlot(refs, plot)
    if (genre) {
      refs.metadataGenreRow.textContent = `${t("cast.remote.genreLabel")}: ${genre}`
      refs.metadataGenreRow.classList.remove("hidden")
    }
    if (plot || genre) revealMetadata(refs)

    try {
      const { resolveTmdbId, fetchMovieEnrichment } = await import("@/scripts/lib/tmdb-enrich.ts")
      const providerTmdbId = Number(info.tmdb_id || movieData.tmdb_id) || null
      const tmdbId = await resolveTmdbId(vodContext.playlistId, "vod", {
        id: vodContext.vodId,
        name: movieData.name || info.name || currentSession.title || "",
        year: movieData.releasedate || movieData.year || info.year || null,
        providerTmdbId,
      })
      if (token !== metadataToken || tmdbId == null) return

      const enrichment = await fetchMovieEnrichment(tmdbId)
      if (token !== metadataToken || !enrichment) return

      if (!plot && enrichment.overview) {
        plot = enrichment.overview
        applyPlot(refs, plot)
      }
      if (!genre && enrichment.genres.length) {
        genre = enrichment.genres.join(", ")
        refs.metadataGenreRow.textContent = `${t("cast.remote.genreLabel")}: ${genre}`
        refs.metadataGenreRow.classList.remove("hidden")
      }
      revealMetadata(refs)
    } catch (err) {
      log.warn("[xt:tv-cast-remote] vod tmdb enrichment failed:", err)
    }
  }

  function refreshMetadata(session: CastSession, force = false): void {
    const key = metadataKeyFor(session)
    if (!force && key === lastMetadataKey) return
    lastMetadataKey = key
    metadataToken += 1
    const token = metadataToken
    resetMetadata(refs)
    const loader = session.liveContext
      ? loadLiveMetadata(session.liveContext, token)
      : session.seriesContext
        ? loadSeriesMetadata(session.seriesContext, token)
        : session.vodContext
          ? loadVodMetadata(session.vodContext, token)
          : null
    // The skeleton has to clear even when the lookup finds nothing to show.
    showMetadataSkeleton(refs, !!loader)
    void loader?.finally(() => {
      if (token === metadataToken) showMetadataSkeleton(refs, false)
    })
  }

  refreshMetadata(currentSession, true)
  void syncPickerEntry()

  const debouncedSetVolume = debounce((level: number, muted: boolean) => {
    castSetVolume(device(), level, muted)
      .then(() => pokeCastStateFeed())
      .catch((err) => log.warn("[xt:tv-cast-remote] set volume failed:", err))
  }, VOLUME_DEBOUNCE_MS)

  function onFeedState(state: CastState): void {
    const idleTeardownAllowed = idleTeardownGuard.allowsTeardown({
      stateValue: state.state,
      sessionStartedAtMs: currentSession.startedAtMs ?? currentSession.startedAt,
      nowMs: Date.now(),
      playPending: isCastPlaySettling(),
    })
    if (state.state === "idle") {
      if (idleTeardownAllowed) settleClose()
      return
    }
    if (state.volume !== undefined) lastKnownVolume = state.volume
    if (state.muted !== undefined) lastKnownMuted = state.muted
    applyState(refs, state)
    setBusy(isBusyStateValue(state.state))
    updateLiveElapsedTicking(currentSession, state.state === "playing")
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
    castSeek(device(), clamped)
      .then(() => pokeCastStateFeed())
      .catch((err) => log.warn("[xt:tv-cast-remote] seek failed:", err))
  }

  function togglePlayPause(): void {
    const paused = refs.playpause.dataset.paused === "true"
    const action = paused ? castResume(device()) : castPause(device())
    action
      .then(() => pokeCastStateFeed())
      .catch((err) => log.warn("[xt:tv-cast-remote] pause/resume failed:", err))
    setPlayPauseIcon(refs, !paused)
  }

  function toggleMute(): void {
    lastKnownMuted = !lastKnownMuted
    setMuteIcon(refs, lastKnownMuted)
    debouncedSetVolume(lastKnownVolume, lastKnownMuted)
  }

  async function skipNeighbor(direction: 1 | -1): Promise<void> {
    const button = direction === 1 ? refs.next : refs.prev
    if (button.disabled) return
    button.disabled = true
    setBusy(true)
    const ok = await castNeighbor(direction)
    setBusy(false)
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
    if (stopArmed && !target.closest('[data-role="footer-stop"]')) disarmStop()

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
      const expanded = refs.metadataPlot.classList.toggle("line-clamp-3") === false
      refs.metadataPlotBtn.setAttribute("aria-expanded", expanded ? "true" : "false")
      refs.metadataPlotToggle.textContent = expanded ? t("cast.remote.plotLess") : t("cast.remote.plotMore")
      return
    }
    if (target.closest('[data-role="retry"]')) {
      void onRetryPressed()
      return
    }
    if (target.closest('[data-role="picker-entry"]')) {
      void openChannelsPanel()
      return
    }
    if (target.closest('[data-role="playpause"]')) {
      togglePlayPause()
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
    if (target.closest('[data-role="mute"]')) {
      toggleMute()
      return
    }
    if (target.closest('[data-role="footer-open"]')) {
      if (currentSession.contentHref) window.location.assign(currentSession.contentHref)
      settleClose()
      return
    }
    if (target.closest('[data-role="footer-stop"]')) {
      onStopPressed()
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
    void syncPickerEntry()
    channelPanel?.refreshNowPlaying()
    applyAvailability(refs, neighborAvailability(currentSession))
    updateLiveElapsedTicking(currentSession, refs.playpause.dataset.paused !== "true")
    void resolveNeighborAvailability(currentSession).then((availability) => {
      applyAvailability(refs, availability)
    })
    refreshMetadata(currentSession)
  }

  function onCancel(event: Event): void {
    event.preventDefault()
    if (panelOpen) {
      if (!channelPanel?.goBack()) closeChannelsPanel()
      return
    }
    settleClose()
  }

  /** Media-style shortcuts. Arrow keys stay untouched: spatial navigation owns them. */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement | null
    const typing = !!target?.closest("input, textarea, select, [contenteditable]")
    const key = event.key.toLowerCase()
    if (typing) return
    if (key === " " || key === "k") {
      if (target?.closest("button")) return
      event.preventDefault()
      togglePlayPause()
      return
    }
    if (key === "m") {
      event.preventDefault()
      toggleMute()
      return
    }
    if (key === "n" && !refs.next.disabled) {
      event.preventDefault()
      void skipNeighbor(1)
      return
    }
    if (key === "p" && !refs.prev.disabled) {
      event.preventDefault()
      void skipNeighbor(-1)
      return
    }
    if (key === "c" && !panelOpen && !!pickerKind) {
      event.preventDefault()
      void openChannelsPanel()
    }
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
    stopLiveElapsedTicker()
    clearStopArmTimeout()
    channelPanel?.destroy()
    channelPanel = null
    feedUnsubscribe()
    dialog.removeEventListener("click", onClick)
    dialog.removeEventListener("keydown", onKeyDown)
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
  dialog.addEventListener("keydown", onKeyDown)
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
