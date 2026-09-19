// Hub hero: a rotating band of what you're most likely to press play on, with the
// page tinted by whatever it is showing.

import { t } from "@/scripts/lib/i18n.js"
import {
  getContinueWatching,
  getRecents,
  getAllGlobalFavorites,
  ensureLoaded as ensurePrefsLoaded,
} from "@/scripts/lib/preferences.js"
import { getCached } from "@/scripts/lib/cache.js"
import { readCachedLiveChannels } from "@/scripts/lib/live-catalog.ts"
import { parseNamePrefix } from "@/scripts/lib/language-tags"
import { backdropFromInfoPayload } from "@/scripts/lib/backdrop.ts"
import { peekTitleEnrichment } from "@/scripts/lib/enrichment.ts"
import { requestVodInfo } from "@/scripts/lib/vod-info.ts"
import { requestSeriesInfo } from "@/scripts/lib/series-seasons.ts"
import { ambientFor } from "@/scripts/tv/ambient-color"
import { log } from "@/scripts/lib/log.js"

const ROTATION_INTERVAL_MS = 10000
const TEXT_DIP_MS = 160
const POOL_LIMIT = 8

type TitleKind = "vod" | "series"

export interface MarqueeItem {
  key: string
  eyebrow: string
  title: string
  meta: string
  rating: string
  hasProgress: boolean
  /** Opening the title; the CTA may deep-link past it straight into playback. */
  detailHref: string
  ctaHref: string
  ctaLabel: string
  artUrl: string | null
  artKind: "poster" | "logo"
  percent: number
  /** Present for catalogue titles, so a real backdrop can replace the poster. */
  ref?: { kind: TitleKind; id: string | number }
}

interface CatalogRow {
  id?: string | number
  name?: string
  logo?: string | null
  year?: string | number | null
  rating?: string | number | null
  category?: string | null
}

interface ProgressRow {
  kind: "vod" | "episode"
  id: string
  position: number
  duration: number
  name?: string
  seriesId?: string | number | null
  seriesName?: string | null
}

// ── item building ──────────────────────────────────────────────────────────

/** Provider names carry a language/quality prefix ("4K-A+ - Acapulco"); the hero wants the title. */
function cleanTitle(raw: string): string {
  return parseNamePrefix(raw).rest.trim() || raw.trim()
}

function timeLeft(positionSeconds: number, durationSeconds: number): string {
  const remaining = Math.round((durationSeconds - positionSeconds) / 60)
  if (!Number.isFinite(remaining) || remaining <= 0) return ""
  if (remaining < 60) return t("hub.marquee.minutesLeft", { count: String(remaining) })
  const hours = Math.floor(remaining / 60)
  const minutes = remaining % 60
  return t("hub.marquee.timeLeft", { time: minutes ? `${hours}h ${minutes}m` : `${hours}h` })
}

function metaFor(row: CatalogRow | undefined): string {
  return row?.year ? String(row.year) : ""
}

/** Favourites already know they're favourites; show what the title is instead. */
function genreEyebrow(row: CatalogRow | undefined): string {
  return (row?.category || "").trim()
}

function ratingFor(row: CatalogRow | undefined): string {
  const rating = Number(row?.rating)
  return Number.isFinite(rating) && rating > 0 ? rating.toFixed(1) : ""
}

function indexById(rows: CatalogRow[]): Map<number, CatalogRow> {
  return new Map(rows.map((row) => [Number(row.id), row]))
}

function continueWatchingItems(
  playlistId: string,
  vodById: Map<number, CatalogRow>,
  seriesById: Map<number, CatalogRow>
): MarqueeItem[] {
  const out: MarqueeItem[] = []
  for (const row of getContinueWatching(playlistId, 4) as ProgressRow[]) {
    const percent =
      row.duration > 0 ? Math.max(0, Math.min(100, (row.position / row.duration) * 100)) : 0
    if (row.kind === "vod") {
      const movie = vodById.get(Number(row.id))
      const title = movie?.name || row.name
      if (!title) continue
      out.push({
        key: `vod:${row.id}`,
        eyebrow: t("hub.strip.continueWatching"),
        title: cleanTitle(title),
        meta: timeLeft(row.position, row.duration) || metaFor(movie),
        rating: ratingFor(movie),
        hasProgress: row.duration > 0,
        detailHref: `/movies/detail?id=${encodeURIComponent(String(row.id))}`,
        ctaHref: `/movies/detail?id=${encodeURIComponent(String(row.id))}&autoplay=1`,
        ctaLabel: t("hub.marquee.resume"),
        artUrl: movie?.logo || null,
        artKind: "poster",
        percent,
        ref: { kind: "vod", id: row.id },
      })
      continue
    }
    const title = row.seriesName || row.name
    if (!title) continue
    const episode = row.name && row.name !== title ? row.name : ""
    const series = row.seriesId ? seriesById.get(Number(row.seriesId)) : undefined
    out.push({
      key: `episode:${row.id}`,
      eyebrow: t("hub.strip.continueWatching"),
      title: cleanTitle(title),
      meta: [episode, timeLeft(row.position, row.duration)].filter(Boolean).join(" · "),
      rating: ratingFor(series),
      hasProgress: row.duration > 0,
      detailHref: row.seriesId
        ? `/series/detail?id=${encodeURIComponent(String(row.seriesId))}`
        : "/series",
      ctaHref: row.seriesId
        ? `/series/detail?id=${encodeURIComponent(String(row.seriesId))}&autoplay=1&episode=${encodeURIComponent(String(row.id))}`
        : "/series",
      ctaLabel: t("hub.marquee.resume"),
      artUrl: series?.logo || null,
      artKind: "poster",
      percent,
      ref: row.seriesId ? { kind: "series", id: row.seriesId } : undefined,
    })
  }
  return out
}

function lastLiveItem(playlistId: string): MarqueeItem | null {
  const [recent] = getRecents(playlistId, "live") || []
  if (!recent) return null
  const channel = readCachedLiveChannels(playlistId).find(
    (row) => Number(row.id) === Number(recent.id)
  )
  const title = channel?.name || recent.name
  if (!title) return null
  return {
    key: `live:${recent.id}`,
    eyebrow: t("nav.livetv"),
    title: cleanTitle(title),
    meta: "",
    rating: "",
    hasProgress: false,
    detailHref: `/livetv?channel=${encodeURIComponent(String(recent.id))}`,
    ctaHref: `/livetv?channel=${encodeURIComponent(String(recent.id))}`,
    ctaLabel: t("hub.marquee.watch"),
    artUrl: channel?.logo || recent.logo || null,
    artKind: "logo",
    percent: 0,
  }
}

function favouriteItems(
  playlistId: string,
  vodById: Map<number, CatalogRow>,
  seriesById: Map<number, CatalogRow>
): MarqueeItem[] {
  const out: MarqueeItem[] = []
  for (const favourite of getAllGlobalFavorites()) {
    if (favourite.playlistId !== playlistId) continue
    if (favourite.kind !== "vod" && favourite.kind !== "series") continue
    const kind: TitleKind = favourite.kind
    const row = (kind === "vod" ? vodById : seriesById).get(Number(favourite.id))
    if (!row?.name) continue
    out.push({
      key: `fav:${kind}:${favourite.id}`,
      eyebrow: genreEyebrow(row),
      title: cleanTitle(row.name),
      meta: metaFor(row),
      rating: ratingFor(row),
      hasProgress: false,
      detailHref: `/${kind === "vod" ? "movies" : "series"}/detail?id=${encodeURIComponent(String(favourite.id))}`,
      ctaHref: `/${kind === "vod" ? "movies" : "series"}/detail?id=${encodeURIComponent(String(favourite.id))}`,
      ctaLabel: t("hub.marquee.watch"),
      artUrl: row.logo || null,
      artKind: "poster",
      percent: 0,
      ref: { kind, id: favourite.id },
    })
  }
  return out
}

function recentlyAddedItems(vod: CatalogRow[]): MarqueeItem[] {
  return vod
    .filter((row) => row?.name && row?.logo)
    .slice(0, 4)
    .map((row) => ({
      key: `new:${row.id}`,
      eyebrow: t("hub.marquee.new"),
      title: cleanTitle(row.name!),
      meta: metaFor(row),
      rating: ratingFor(row),
      hasProgress: false,
      detailHref: `/movies/detail?id=${encodeURIComponent(String(row.id))}`,
      ctaHref: `/movies/detail?id=${encodeURIComponent(String(row.id))}`,
      ctaLabel: t("hub.marquee.watch"),
      artUrl: row.logo || null,
      artKind: "poster" as const,
      percent: 0,
      ref: { kind: "vod" as TitleKind, id: row.id! },
    }))
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const swapWith = Math.floor(Math.random() * (i + 1))
    const held = out[i]
    out[i] = out[swapWith]
    out[swapWith] = held
  }
  return out
}

/**
 * Continue watching leads in order, then a shuffled tail of the last live channel,
 * favourites and new arrivals - so the band opens on what you were watching but
 * doesn't show the same second title every visit.
 */
export async function buildMarqueePool(playlistId: string): Promise<MarqueeItem[]> {
  await ensurePrefsLoaded()
  const vod = (getCached(playlistId, "vod")?.data || []) as CatalogRow[]
  const series = (getCached(playlistId, "series")?.data || []) as CatalogRow[]
  const vodById = indexById(vod)
  const seriesById = indexById(series)

  const live = lastLiveItem(playlistId)
  const lead = continueWatchingItems(playlistId, vodById, seriesById)
  const tail = shuffle([
    ...(live ? [live] : []),
    ...favouriteItems(playlistId, vodById, seriesById),
    ...recentlyAddedItems(vod),
  ])

  const seen = new Set<string>()
  const pool: MarqueeItem[] = []
  for (const item of [...lead, ...tail]) {
    if (seen.has(item.key)) continue
    seen.add(item.key)
    pool.push(item)
    if (pool.length >= POOL_LIMIT) break
  }
  return pool
}

// ── artwork ladder: TVDB banner → provider backdrop → poster ───────────────

const backdropByKey = new Map<string, string | null>()

function refKey(playlistId: string, ref: { kind: TitleKind; id: string | number }): string {
  return `${playlistId}:${ref.kind}:${ref.id}`
}

function cachedProviderBackdrop(
  playlistId: string,
  ref: { kind: TitleKind; id: string | number }
): string | null {
  const hit = getCached(
    playlistId,
    ref.kind === "vod" ? `vod_info_${ref.id}` : `series_info_${ref.id}`
  )
  return hit ? backdropFromInfoPayload(hit.data) : null
}

/** Best artwork available now; the lazy lookups call `onResolved` when something better lands. */
function resolveArtwork(
  playlistId: string,
  item: MarqueeItem,
  onResolved: (key: string) => void
): string | null {
  if (!item.ref) return item.artUrl
  const key = refKey(playlistId, item.ref)

  const known = backdropByKey.get(key)
  if (known) return known

  const provider = cachedProviderBackdrop(playlistId, item.ref)
  if (provider) {
    backdropByKey.set(key, provider)
    return provider
  }

  if (!backdropByKey.has(key)) {
    backdropByKey.set(key, null)
    const { kind, id } = item.ref
    void peekTitleEnrichment(kind === "vod" ? "movie" : "series", playlistId, String(id))
      .then((enrichment) => {
        const bannerUrl = enrichment?.bannerUrl ?? null
        if (!bannerUrl) return
        backdropByKey.set(key, bannerUrl)
        onResolved(item.key)
      })
      .catch(() => {})
    const info = kind === "vod" ? requestVodInfo(playlistId, id) : requestSeriesInfo(playlistId, id)
    void Promise.resolve(info)
      .then((data: unknown) => {
        const url = data ? backdropFromInfoPayload(data) : null
        if (!url || backdropByKey.get(key)) return
        backdropByKey.set(key, url)
        onResolved(item.key)
      })
      .catch(() => {})
  }
  return item.artUrl
}

// ── rendering ──────────────────────────────────────────────────────────────

function ensureWash(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(".hub-ambient-wash")
  if (existing) return existing
  const wash = document.createElement("div")
  wash.className = "hub-ambient-wash"
  wash.setAttribute("aria-hidden", "true")
  document.body.appendChild(wash)
  return wash
}

async function applyAmbient(imageUrl: string | null, kind: "poster" | "logo"): Promise<void> {
  const wash = ensureWash()
  if (!imageUrl) {
    delete wash.dataset.on
    return
  }
  try {
    const ambient = await ambientFor(imageUrl, kind === "logo" ? "logo" : "poster")
    if (!ambient) return
    const root = document.documentElement
    root.style.setProperty("--xt-hub-ambient", ambient.css)
    root.style.setProperty("--xt-hub-ambient-soft", ambient.soft)
    root.style.setProperty("--xt-hub-ambient-glow", ambient.glow)
    wash.dataset.on = "true"
  } catch (error) {
    log.warn("[hub] ambient failed:", error)
  }
}

function motionAllowed(): boolean {
  if (document.documentElement.getAttribute("data-perf-mode") === "on") return false
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export interface MarqueeHandle {
  destroy(): void
}

/** Reserves the band while the pool resolves, so the page below never jumps. */
export function showMarqueeSkeleton(section: HTMLElement): void {
  if (!section.hidden) return
  section.dataset.loading = "true"
  section.hidden = false
}

export function mountMarquee(
  section: HTMLElement,
  playlistId: string,
  pool: MarqueeItem[]
): MarqueeHandle | null {
  delete section.dataset.loading
  if (!pool.length) {
    section.hidden = true
    return null
  }

  const query = <T extends HTMLElement>(role: string) =>
    section.querySelector<T>(`[data-role="${role}"]`)!
  const artLayers = [query<HTMLElement>("art"), query<HTMLElement>("art-alt")]
  const posterLayers = [query<HTMLElement>("poster"), query<HTMLElement>("poster-alt")]
  const link = query<HTMLAnchorElement>("hero-link")
  let front = 0
  const progress = query<HTMLElement>("progress")
  const cta = query<HTMLAnchorElement>("cta")

  const dots = section.querySelector<HTMLElement>('[data-role="dots"]')
  let index = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let paused = false
  // WCAG 2.2.2: picking a title is the mechanism that stops the rotation.
  let stopped = false

  function show(item: MarqueeItem): void {
    query("eyebrow").textContent = item.eyebrow
    query("title").textContent = item.title
    const meta = query("meta")
    meta.textContent = item.meta
    meta.hidden = !item.meta

    const rating = query("rating")
    rating.hidden = !item.rating
    if (item.rating) {
      query("rating-value").textContent = item.rating
      rating.setAttribute("aria-label", t("list.ratingAria", { rating: item.rating }))
    }

    progress.hidden = !item.hasProgress
    if (item.hasProgress) {
      // A barely-started title still deserves a visible sliver.
      const width = Math.max(item.percent, 1.5)
      query<HTMLSpanElement>("progress-fill").style.width = `${width.toFixed(1)}%`
    }

    const eyebrowEl = query("eyebrow")
    eyebrowEl.hidden = !item.eyebrow

    link.href = item.detailHref
    link.setAttribute("aria-label", item.title)
    cta.href = item.ctaHref
    cta.setAttribute("aria-label", `${item.ctaLabel}: ${item.title}`)
    query("cta-label").textContent = item.ctaLabel

    const artworkUrl = resolveArtwork(playlistId, item, (key) => {
      if (pool[index]?.key === key) show(pool[index])
    })
    if (!artworkUrl) {
      for (const layer of [...artLayers, ...posterLayers]) delete layer.dataset.on
      return
    }
    const probe = new Image()
    probe.referrerPolicy = "no-referrer"
    probe.decoding = "async"
    probe.onload = () => {
      if (pool[index]?.key !== item.key) return
      const url = `url(${JSON.stringify(artworkUrl)})`
      // Wide artwork is a backdrop: let it fill the band. A poster or channel logo
      // is nowhere near 16:9, so it gets the blurred bed plus its own plate.
      const wide = item.artKind !== "logo" && probe.naturalWidth > probe.naturalHeight * 1.2
      // Paint into the back layer and swap, so a change crossfades instead of cutting.
      const back = front === 0 ? 1 : 0
      const incomingArt = artLayers[back]
      const incomingPoster = posterLayers[back]
      incomingArt.style.backgroundImage = url
      incomingArt.dataset.portrait = String(!wide)
      if (wide) {
        delete incomingPoster.dataset.on
      } else {
        incomingPoster.style.backgroundImage = url
        incomingPoster.dataset.kind = item.artKind
        incomingPoster.dataset.on = "true"
      }
      incomingArt.dataset.on = "true"
      delete artLayers[front].dataset.on
      delete posterLayers[front].dataset.on
      front = back
    }
    probe.src = artworkUrl
    void applyAmbient(artworkUrl, item.artKind)
  }

  const body = section.querySelector<HTMLElement>(".hub-marquee__body")

  function goTo(next: number): void {
    index = ((next % pool.length) + pool.length) % pool.length
    syncDots()
    if (!body) {
      show(pool[index])
      return
    }
    body.dataset.swapping = "true"
    window.setTimeout(() => {
      show(pool[index])
      delete body.dataset.swapping
    }, TEXT_DIP_MS)
  }

  function advance(): void {
    if (paused || stopped || document.hidden || pool.length < 2) return
    goTo(index + 1)
  }

  function stopRotation(): void {
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function syncDots(): void {
    if (!dots) return
    for (const [dotIndex, dot] of [...dots.children].entries()) {
      const current = dotIndex === index
      dot.setAttribute("aria-current", String(current))
      ;(dot as HTMLButtonElement).tabIndex = current ? 0 : -1
    }
  }

  function buildDots(): void {
    if (!dots || pool.length < 2) return
    dots.replaceChildren(
      ...pool.map((item, dotIndex) => {
        const dot = document.createElement("button")
        dot.type = "button"
        dot.className = "hub-marquee__dot"
        dot.setAttribute(
          "aria-label",
          t("hub.marquee.showItem", { n: String(dotIndex + 1), total: String(pool.length), title: item.title })
        )
        dot.addEventListener("click", () => {
          stopRotation()
          goTo(dotIndex)
          dot.focus()
        })
        return dot
      })
    )
    dots.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return
      ev.preventDefault()
      stopRotation()
      goTo(index + (ev.key === "ArrowRight" ? 1 : -1))
      ;(dots.children[index] as HTMLElement | undefined)?.focus()
    })
    dots.hidden = false
    syncDots()
  }

  // Touch has no hover to pause with, so a swipe is the transport control there.
  function bindSwipe(): (() => void) | null {
    if (pool.length < 2) return null
    let startX = 0
    let startY = 0
    let tracking = false
    const onStart = (ev: PointerEvent) => {
      if (ev.pointerType === "mouse") return
      tracking = true
      startX = ev.clientX
      startY = ev.clientY
    }
    const onEnd = (ev: PointerEvent) => {
      if (!tracking) return
      tracking = false
      const dx = ev.clientX - startX
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(ev.clientY - startY)) return
      ev.preventDefault()
      // pointerup's preventDefault doesn't reliably cancel the click, and the
      // whole band is a link - swallow the one that follows a swipe.
      section.addEventListener("click", (click) => {
        click.preventDefault()
        click.stopPropagation()
      }, { capture: true, once: true })
      stopRotation()
      goTo(index + (dx < 0 ? 1 : -1))
    }
    section.addEventListener("pointerdown", onStart)
    section.addEventListener("pointerup", onEnd)
    section.addEventListener("pointercancel", () => (tracking = false))
    return () => {
      section.removeEventListener("pointerdown", onStart)
      section.removeEventListener("pointerup", onEnd)
    }
  }

  buildDots()
  show(pool[0])
  syncDots()
  section.hidden = false
  const unbindSwipe = bindSwipe()

  const pause = () => {
    paused = true
  }
  const resume = () => {
    paused = false
  }
  section.addEventListener("pointerenter", pause)
  section.addEventListener("pointerleave", resume)
  section.addEventListener("focusin", pause)
  section.addEventListener("focusout", resume)

  if (motionAllowed() && pool.length > 1) timer = setInterval(advance, ROTATION_INTERVAL_MS)

  return {
    destroy(): void {
      if (timer) clearInterval(timer)
      unbindSwipe?.()
      dots?.replaceChildren()
      if (dots) dots.hidden = true
      section.removeEventListener("pointerenter", pause)
      section.removeEventListener("pointerleave", resume)
      section.removeEventListener("focusin", pause)
      section.removeEventListener("focusout", resume)
    },
  }
}
