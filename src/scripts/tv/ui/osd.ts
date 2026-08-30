// TV embedded-playback OSD: live channel banner, VOD scrub strip, number-pad zap readout.
// Dark chrome over video in both themes (cinematic surface exception); WAAPI drives motion
// with a `.tv-osd-panel` CSS hook reserved for when tv.css grows its own [hidden] transition.
import { t, getActiveLocale } from "@/scripts/lib/i18n"
import { motionAllowed, TV_EASE } from "@/scripts/tv/motion"
import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { formatPaddedHms } from "@/scripts/lib/format.ts"
import { getProgrammesSync, effectiveTvgId } from "@/scripts/lib/epg-data.js"
import { computeNowNext, formatTimeRange, type NowNextSlot } from "@/scripts/lib/now-next"
import { tvEpgSource, toXtreamCreds, tvShortEpgCache, shortEpgNowNextSlot } from "@/scripts/tv/epg-source"
import { resolvePlaylistCreds } from "@/scripts/lib/tv-cast-live.js"
import type { ShortEpgNowNext } from "@/scripts/lib/short-epg.ts"

export interface OsdLiveChannel {
  id: string | number
  name: string
  logo?: string | null
  number?: number | null
  tvgId?: string | null
  tvgShift?: number | null
}

export interface OsdHandle {
  showLiveBanner(playlistId: string, channel: OsdLiveChannel): void
  hideLiveBanner(): void
  liveBannerVisible(): boolean
  showZapDigits(digits: string): void
  showZapMiss(digits: string): void
  hideZap(): void
  showVodScrub(positionSeconds: number, durationSeconds: number | undefined, flashDeltaSeconds?: number): void
  hideAll(): void
}

const LIVE_BANNER_HIDE_MS = 4000
const LIVE_TICK_MS = 30_000
const VOD_SCRUB_HIDE_MS = 3000
const VOD_FLASH_HIDE_MS = 900
const ZAP_MISS_HIDE_MS = 1000
const PANEL_ANIMATE_MS = 240

function markup(): string {
  return `
    <div data-role="live-banner" class="tv-osd-panel pointer-events-none absolute inset-x-0 bottom-0 flex justify-start p-6" hidden>
      <div class="flex max-w-xl items-center gap-4 rounded-2xl bg-black/70 px-5 py-4 text-white">
        <span data-role="logo" class="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white/10 ring-1 ring-inset ring-white/15">
          <img data-role="logo-img" alt="" class="hidden h-full w-full object-contain p-1.5" />
          <span data-role="logo-fallback" class="text-lg font-semibold text-white/70"></span>
        </span>
        <div class="flex min-w-0 flex-col gap-1.5">
          <div class="flex items-baseline gap-2">
            <span data-role="number" class="text-sm font-semibold tabular-nums text-white/60"></span>
            <span data-role="name" class="truncate text-lg font-semibold"></span>
          </div>
          <div data-role="now-row" class="flex items-baseline gap-2 text-sm text-white/80">
            <span data-role="now-title" class="truncate"></span>
            <span data-role="now-time" class="shrink-0 tabular-nums text-white/50"></span>
          </div>
          <span data-role="progress-track" class="block h-1 w-64 max-w-full overflow-hidden rounded-full bg-white/20">
            <span data-role="progress-fill" class="block h-full origin-left rounded-full bg-accent"></span>
          </span>
          <span data-role="next-row" class="truncate text-xs text-white/50"></span>
        </div>
      </div>
    </div>
    <div data-role="zap" class="tv-osd-panel pointer-events-none absolute inset-x-0 bottom-0 flex justify-start p-6" hidden>
      <div class="flex items-center gap-4 rounded-2xl bg-black/70 px-6 py-4 text-white">
        <span data-role="zap-digits" class="text-4xl font-semibold tabular-nums"></span>
        <span data-role="zap-status" class="text-sm text-white/60"></span>
      </div>
    </div>
    <div data-role="vod-scrub" class="tv-osd-panel pointer-events-none absolute inset-x-6 bottom-6 flex flex-col gap-2 rounded-2xl bg-black/70 px-5 py-4 text-white" hidden>
      <div class="flex items-center justify-between gap-3 text-sm tabular-nums text-white/85">
        <span data-role="elapsed"></span>
        <span data-role="delta" class="font-semibold text-accent" hidden></span>
        <span data-role="remaining"></span>
      </div>
      <span data-role="vod-progress-track" class="block h-1 w-full overflow-hidden rounded-full bg-white/20">
        <span data-role="vod-progress-fill" class="block h-full origin-left rounded-full bg-accent"></span>
      </span>
    </div>
  `
}

function reveal(el: HTMLElement): void {
  const wasHidden = el.hidden
  el.hidden = false
  if (!wasHidden || !motionAllowed()) return
  el.animate(
    [
      { opacity: 0, transform: "translateY(0.5rem)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
    { duration: PANEL_ANIMATE_MS, easing: TV_EASE }
  )
}

function conceal(el: HTMLElement): void {
  if (el.hidden) return
  if (!motionAllowed()) {
    el.hidden = true
    return
  }
  const animation = el.animate(
    [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0, transform: "translateY(0.5rem)" },
    ],
    { duration: PANEL_ANIMATE_MS, easing: TV_EASE }
  )
  animation.onfinish = () => { el.hidden = true }
  animation.oncancel = () => { el.hidden = true }
}

function setProgressFill(fill: HTMLElement, progress: number): void {
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`
}

export function createOsd(host: HTMLElement): OsdHandle {
  const wrap = document.createElement("div")
  wrap.innerHTML = markup()
  host.appendChild(wrap)

  const query = <T extends HTMLElement>(role: string) => wrap.querySelector<T>(`[data-role="${role}"]`)!

  const liveBanner = query("live-banner")
  const liveLogoImg = query<HTMLImageElement>("logo-img")
  const liveLogoFallback = query("logo-fallback")
  const liveNumber = query("number")
  const liveName = query("name")
  const liveNowRow = query("now-row")
  const liveNowTitle = query("now-title")
  const liveNowTime = query("now-time")
  const liveProgressTrack = query("progress-track")
  const liveProgressFill = query("progress-fill")
  const liveNextRow = query("next-row")

  const zapPanel = query("zap")
  const zapDigitsEl = query("zap-digits")
  const zapStatusEl = query("zap-status")

  const vodPanel = query("vod-scrub")
  const vodElapsed = query("elapsed")
  const vodRemaining = query("remaining")
  const vodDelta = query("delta")
  const vodProgressTrack = query("vod-progress-track")
  const vodProgressFill = query("vod-progress-fill")

  for (const fill of [liveProgressFill, vodProgressFill]) {
    fill.style.transition = motionAllowed() ? `transform ${PANEL_ANIMATE_MS}ms ${TV_EASE}` : "none"
  }

  let liveHideTimer: ReturnType<typeof setTimeout> | null = null
  let liveTickTimer: ReturnType<typeof setInterval> | null = null
  let zapMissTimer: ReturnType<typeof setTimeout> | null = null
  let vodHideTimer: ReturnType<typeof setTimeout> | null = null
  let vodFlashTimer: ReturnType<typeof setTimeout> | null = null
  let liveState: { playlistId: string; channel: OsdLiveChannel } | null = null
  let paintedLogoUrl: string | null = null
  const shortEpgBannerCache = new Map<string, ShortEpgNowNext>()

  function paintLogo(url: string | null | undefined, name: string): void {
    if (url) {
      if (paintedLogoUrl !== url) {
        paintedLogoUrl = url
        mountCachedImage(liveLogoImg, url, "logo")
      }
      liveLogoImg.classList.remove("hidden")
      liveLogoFallback.classList.add("hidden")
    } else {
      paintedLogoUrl = null
      liveLogoImg.classList.add("hidden")
      liveLogoImg.removeAttribute("src")
      liveLogoFallback.classList.remove("hidden")
      liveLogoFallback.textContent = name.trim().charAt(0).toUpperCase() || "?"
    }
  }

  function liveNowNextSlot(playlistId: string, channel: OsdLiveChannel): NowNextSlot {
    const epgState = getProgrammesSync(playlistId)
    const tvgId = epgState ? effectiveTvgId(channel, playlistId) : ""
    if (epgState && tvgId) return computeNowNext(epgState.programmes, channel, playlistId)
    return shortEpgNowNextSlot(shortEpgBannerCache.get(`${playlistId}:${channel.id}`) ?? null)
  }

  // Memory-conservative TVs never bulk-load XMLTV, so the banner falls back to the
  // per-channel short-EPG client; a no-op for M3U sources or when it's off the lite tier.
  function requestShortEpgBanner(playlistId: string, channel: OsdLiveChannel): void {
    void resolvePlaylistCreds(playlistId).then((creds) => {
      if (!creds) return
      const xtreamCreds = toXtreamCreds(playlistId, creds)
      if (tvEpgSource(xtreamCreds) !== "short-epg") return
      void tvShortEpgCache().getNowNext(xtreamCreds, channel.id).then((nowNext) => {
        if (!nowNext) return
        shortEpgBannerCache.set(`${playlistId}:${channel.id}`, nowNext)
        if (liveState?.playlistId === playlistId && String(liveState.channel.id) === String(channel.id)) {
          paintLiveBanner()
        }
      })
    })
  }

  function paintLiveBanner(): void {
    if (!liveState) return
    const { playlistId, channel } = liveState
    liveNumber.textContent = channel.number != null ? String(channel.number) : ""
    liveNumber.hidden = channel.number == null
    liveName.textContent = channel.name
    paintLogo(channel.logo, channel.name)

    const { current, next } = liveNowNextSlot(playlistId, channel)

    liveNowRow.hidden = !current
    liveProgressTrack.hidden = !current
    if (current) {
      liveNowTitle.textContent = current.title
      liveNowTime.textContent = formatTimeRange(current.start, current.stop, getActiveLocale())
      setProgressFill(liveProgressFill, current.progress)
    }

    liveNextRow.hidden = !next
    if (next) liveNextRow.textContent = `${t("detail.upNext")} · ${next.title}`
  }

  function restartLiveHideTimer(): void {
    if (liveHideTimer) clearTimeout(liveHideTimer)
    liveHideTimer = setTimeout(hideLiveBanner, LIVE_BANNER_HIDE_MS)
  }

  function restartLiveTick(): void {
    if (liveTickTimer) clearInterval(liveTickTimer)
    liveTickTimer = setInterval(paintLiveBanner, LIVE_TICK_MS)
  }

  function hideLiveBanner(): void {
    if (liveHideTimer) { clearTimeout(liveHideTimer); liveHideTimer = null }
    if (liveTickTimer) { clearInterval(liveTickTimer); liveTickTimer = null }
    liveState = null
    conceal(liveBanner)
  }

  function showLiveBanner(playlistId: string, channel: OsdLiveChannel): void {
    liveState = { playlistId, channel }
    paintLiveBanner()
    reveal(liveBanner)
    restartLiveHideTimer()
    restartLiveTick()
    requestShortEpgBanner(playlistId, channel)
  }

  function liveBannerVisible(): boolean {
    return !liveBanner.hidden
  }

  function clearZapMissTimer(): void {
    if (zapMissTimer) { clearTimeout(zapMissTimer); zapMissTimer = null }
  }

  function showZapDigits(digits: string): void {
    clearZapMissTimer()
    zapDigitsEl.textContent = digits
    zapDigitsEl.classList.remove("text-white/40")
    zapStatusEl.textContent = ""
    reveal(zapPanel)
  }

  function showZapMiss(digits: string): void {
    zapDigitsEl.textContent = digits
    zapDigitsEl.classList.add("text-white/40")
    zapStatusEl.textContent = t("tv.osd.channelNotFound")
    reveal(zapPanel)
    clearZapMissTimer()
    zapMissTimer = setTimeout(hideZap, ZAP_MISS_HIDE_MS)
  }

  function hideZap(): void {
    clearZapMissTimer()
    conceal(zapPanel)
  }

  function showVodScrub(positionSeconds: number, durationSeconds: number | undefined, flashDeltaSeconds?: number): void {
    reveal(vodPanel)
    vodElapsed.textContent = formatPaddedHms(positionSeconds)
    const hasDuration = typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
    vodRemaining.hidden = !hasDuration
    vodProgressTrack.hidden = !hasDuration
    if (hasDuration) {
      vodRemaining.textContent = `-${formatPaddedHms(Math.max(0, durationSeconds - positionSeconds))}`
      setProgressFill(vodProgressFill, positionSeconds / durationSeconds)
    }

    if (vodFlashTimer) { clearTimeout(vodFlashTimer); vodFlashTimer = null }
    if (typeof flashDeltaSeconds === "number") {
      vodDelta.hidden = false
      vodDelta.textContent = `${flashDeltaSeconds > 0 ? "+" : "-"}${Math.abs(flashDeltaSeconds)}s`
      vodFlashTimer = setTimeout(() => { vodDelta.hidden = true }, VOD_FLASH_HIDE_MS)
    } else {
      vodDelta.hidden = true
    }

    if (vodHideTimer) clearTimeout(vodHideTimer)
    vodHideTimer = setTimeout(() => conceal(vodPanel), VOD_SCRUB_HIDE_MS)
  }

  function hideAll(): void {
    hideLiveBanner()
    hideZap()
    if (vodHideTimer) { clearTimeout(vodHideTimer); vodHideTimer = null }
    if (vodFlashTimer) { clearTimeout(vodFlashTimer); vodFlashTimer = null }
    liveBanner.hidden = true
    zapPanel.hidden = true
    vodPanel.hidden = true
  }

  return { showLiveBanner, hideLiveBanner, liveBannerVisible, showZapDigits, showZapMiss, hideZap, showVodScrub, hideAll }
}
