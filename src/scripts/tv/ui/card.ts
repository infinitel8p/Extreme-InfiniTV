// Shared TV home-rail card: 2:3 poster footprint for VOD/series/episode/live.

import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { makeFallback } from "@/scripts/lib/entry-card.ts"
import { fmtImdbRating } from "@/scripts/lib/format.ts"
import { attachLongPress, type LongPressHandle } from "@/scripts/tv/long-press.ts"
import { memoryConservative, effectTier, heavyBlurClass } from "@/scripts/tv/motion"
import { navigate } from "astro:transitions/client"

export type CardKind = "vod" | "series" | "episode" | "live"

interface CardItemBase {
  railId: string
  id: string | number
  name: string
}

export interface PosterCardItem extends CardItemBase {
  kind: "vod" | "series" | "episode"
  href: string
  posterUrl: string | null
  meta: string
  ariaLabel: string
  progressPercent?: number | null
  /** When set, activation resumes playback instead of the default href navigation. */
  onActivate?: () => void
  /** When set, a D-pad hold or touch long-press opens an action sheet instead of activating. */
  onLongPress?: () => void
}

export interface LiveCardItem extends CardItemBase {
  kind: "live"
  logoUrl: string | null
  nowTitle: string
  ariaLabel: string
  onActivate: () => void
  onLongPress?: () => void
}

export type CardItem = PosterCardItem | LiveCardItem

export interface CardRenderOptions {
  /** Grid rows size cards to fill the column track instead of a fixed rail width. */
  fill?: boolean
  /** Skips native lazy-loading - for cards close enough to the fold to need their poster now. */
  eager?: boolean
}

export function cardFocusKey(railId: string, kind: CardKind, id: string | number): string {
  return `${railId}:${kind}:${id}`
}

const ACTIVE_POSTER_NAME = "tv-active-poster"
const ACTIVE_TITLE_NAME = "tv-active-title"
const FORWARD_MORPH_CANCEL_MS = 1200

let namedPosterEl: HTMLElement | null = null
let namedTitleEl: HTMLElement | null = null
let clearNamedTimer: ReturnType<typeof setTimeout> | null = null

function clearNamedPoster(): void {
  if (clearNamedTimer != null) {
    clearTimeout(clearNamedTimer)
    clearNamedTimer = null
  }
  if (namedPosterEl) {
    namedPosterEl.style.viewTransitionName = ""
    namedPosterEl = null
  }
  if (namedTitleEl) {
    namedTitleEl.style.viewTransitionName = ""
    namedTitleEl = null
  }
}

function nameElementsForMorph(posterWrap: HTMLElement | null, titleEl: HTMLElement | null): void {
  clearNamedPoster()
  if (!posterWrap) return
  posterWrap.style.viewTransitionName = ACTIVE_POSTER_NAME
  namedPosterEl = posterWrap
  if (titleEl) {
    titleEl.style.viewTransitionName = ACTIVE_TITLE_NAME
    namedTitleEl = titleEl
  }
}

function isDetailHref(href: string | null): boolean {
  return !!href && (href.startsWith("/tv/movies/detail") || href.startsWith("/tv/series/detail"))
}

/** Names the card the list view is returning to, so a back navigation morphs into it. */
export function nameReturningCard(container: HTMLElement, entryKey: string): boolean {
  const card = container.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(entryKey)}"]`)
  if (!card) return false
  nameElementsForMorph(
    card.querySelector<HTMLElement>("[data-poster-wrap]"),
    card.querySelector<HTMLElement>("[data-card-title]")
  )
  return true
}

if (typeof document !== "undefined") {
  // Real navigation is underway - the safety-net timeout no longer applies.
  document.addEventListener("astro:before-swap", () => {
    if (clearNamedTimer != null) {
      clearTimeout(clearNamedTimer)
      clearNamedTimer = null
    }
  })
  document.addEventListener("astro:page-load", clearNamedPoster)
}

/** Content identity for keyed reconcile - stable across a rail rebuild even when railId is stable too. */
export function cardEntryKey(item: CardItem): string {
  return `${item.kind}:${item.id}`
}

/** Forces a reused card's already-decoded images to repaint immediately instead of re-queuing lazy load/decode. */
export function keepCardMediaDecoded(card: HTMLElement): void {
  // Lite skips this entirely - reused cards stay lazy/async, no forced decode.
  if (memoryConservative()) return
  for (const img of card.querySelectorAll<HTMLImageElement>("img")) {
    img.loading = "eager"
  }
}

/** Shared movies/series card meta line: "year · rating", either half omitted when absent. */
export function formatCardMeta(year: unknown, rating: unknown): string {
  const yearText = String(year ?? "").match(/\d{4}/)?.[0] || ""
  const ratingText = fmtImdbRating(rating)
  return [yearText, ratingText].filter(Boolean).join(" · ")
}

const CARD_FOCUS_CLASSES = "self-start outline-none tv-focus-card"

interface CardBehavior {
  activate?: () => void
  longPress?: () => void
}

// Listeners read through this indirection so updateCard can rewire behavior without re-attaching.
const cardBehaviors = new WeakMap<HTMLElement, CardBehavior>()

/** Wires activation (click/Enter) and, when given, a long-press action sheet trigger. */
function buildActivate(
  card: HTMLElement,
  href: string | null,
  onActivate: (() => void) | undefined
): (() => void) | undefined {
  // Must stay a ClientRouter navigation: a full load skips the swap events focus memory rides on.
  const runNavigate = onActivate ?? (href ? () => { void navigate(href) } : undefined)
  if (!runNavigate || !isDetailHref(href)) return runNavigate
  return () => {
    nameElementsForMorph(
      card.querySelector<HTMLElement>("[data-poster-wrap]"),
      card.querySelector<HTMLElement>("[data-card-title]")
    )
    clearNamedTimer = setTimeout(clearNamedPoster, FORWARD_MORPH_CANCEL_MS)
    runNavigate()
  }
}

function wireCardActivation(
  card: HTMLElement,
  href: string | null,
  onActivate: (() => void) | undefined,
  onLongPress: (() => void) | undefined
): void {
  const activate = buildActivate(card, href, onActivate)
  cardBehaviors.set(card, { activate, longPress: onLongPress })
}

/**
 * One delegated long-press listener set for a rail/grid track instead of one per card - each
 * card only registers its behavior in `cardBehaviors` via `wireCardActivation`/`updateCardBehavior`.
 */
export function registerCardLongPress(container: HTMLElement): LongPressHandle {
  return attachLongPress<HTMLElement>({
    container,
    targetSelector: "[data-focus-key]",
    resolveTarget: (row) => row,
    onActivate: (card) => cardBehaviors.get(card)?.activate?.(),
    onLongPress: (card) => cardBehaviors.get(card)?.longPress?.(),
  })
}

function updateCardBehavior(
  card: HTMLElement,
  href: string | null,
  onActivate: (() => void) | undefined,
  onLongPress: (() => void) | undefined
): void {
  const activate = buildActivate(card, href, onActivate)
  cardBehaviors.set(card, { activate, longPress: onLongPress })
}

function buildPosterImage(posterUrl: string | null, name: string, eager?: boolean): HTMLElement {
  if (!posterUrl) return makeFallback(name)
  const img = document.createElement("img")
  img.alt = ""
  img.loading = eager ? "eager" : "lazy"
  img.decoding = "async"
  img.className = "block h-full w-full object-cover"
  mountCachedImage(img, posterUrl, "poster")
  return img
}

function buildProgressTrack(percent: number): HTMLElement {
  const progressTrack = document.createElement("div")
  progressTrack.dataset.progressTrack = "1"
  progressTrack.className = "absolute inset-x-0 bottom-0 h-1 bg-black/55"
  const progressFill = document.createElement("div")
  progressFill.className = "h-full bg-accent"
  progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`
  progressTrack.appendChild(progressFill)
  return progressTrack
}

function createPosterCard(item: PosterCardItem, options?: CardRenderOptions): HTMLAnchorElement {
  const card = document.createElement("a")
  card.href = item.href
  card.dataset.focusKey = cardFocusKey(item.railId, item.kind, item.id)
  card.dataset.entryKey = cardEntryKey(item)
  card.setAttribute("aria-label", item.ariaLabel)
  const widthClass = options?.fill ? "w-full" : "w-[9.5rem] shrink-0"
  card.className = `flex ${widthClass} flex-col gap-2 rounded-xl ${CARD_FOCUS_CLASSES}`

  const posterWrap = document.createElement("div")
  posterWrap.dataset.posterWrap = "1"
  posterWrap.dataset.imageUrl = item.posterUrl || ""
  posterWrap.className =
    "relative isolate aspect-[2/3] w-full overflow-hidden rounded-xl bg-black/40 tv-edge-mask"
  posterWrap.appendChild(buildPosterImage(item.posterUrl, item.name, options?.eager))

  if (item.progressPercent != null && item.progressPercent > 0) {
    posterWrap.appendChild(buildProgressTrack(item.progressPercent))
  }

  const title = document.createElement("div")
  title.dataset.cardTitle = "1"
  title.className = "tv-card-title truncate text-sm font-medium text-fg-2"
  title.textContent = item.name

  const meta = document.createElement("div")
  meta.dataset.cardMeta = "1"
  meta.className = "min-h-4 truncate text-xs text-fg-3"
  meta.textContent = item.meta

  card.append(posterWrap, title, meta)
  if (item.posterUrl) card.dataset.prefetchUrl = item.posterUrl
  wireCardActivation(card, item.href, item.onActivate, item.onLongPress)
  return card
}

function updatePosterCard(card: HTMLAnchorElement, item: PosterCardItem): void {
  card.href = item.href
  card.setAttribute("aria-label", item.ariaLabel)
  if (item.posterUrl) card.dataset.prefetchUrl = item.posterUrl
  else delete card.dataset.prefetchUrl

  const posterWrap = card.querySelector<HTMLElement>("[data-poster-wrap]")
  if (posterWrap && posterWrap.dataset.imageUrl !== (item.posterUrl || "")) {
    posterWrap.dataset.imageUrl = item.posterUrl || ""
    const progressTrack = posterWrap.querySelector<HTMLElement>("[data-progress-track]")
    posterWrap.replaceChildren(buildPosterImage(item.posterUrl, item.name))
    if (progressTrack) posterWrap.appendChild(progressTrack)
  }

  if (posterWrap) {
    let progressTrack = posterWrap.querySelector<HTMLElement>("[data-progress-track]")
    if (item.progressPercent != null && item.progressPercent > 0) {
      if (!progressTrack) {
        progressTrack = buildProgressTrack(item.progressPercent)
        posterWrap.appendChild(progressTrack)
      } else {
        const progressFill = progressTrack.firstElementChild as HTMLElement | null
        if (progressFill) progressFill.style.width = `${Math.max(0, Math.min(100, item.progressPercent))}%`
      }
    } else if (progressTrack) {
      progressTrack.remove()
    }
  }

  const title = card.querySelector<HTMLElement>("[data-card-title]")
  if (title) title.textContent = item.name
  const meta = card.querySelector<HTMLElement>("[data-card-meta]")
  if (meta) meta.textContent = item.meta

  updateCardBehavior(card, item.href, item.onActivate, item.onLongPress)
}

function buildLiveTile(logoUrl: string | null, name: string): HTMLElement[] {
  if (!logoUrl) return [makeFallback(name)]
  const backdrop = document.createElement("img")
  backdrop.alt = ""
  backdrop.setAttribute("aria-hidden", "true")
  backdrop.loading = "lazy"
  backdrop.decoding = "async"
  backdrop.className = heavyBlurClass(
    "absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-2xl saturate-150",
    "absolute inset-0 bg-surface-2"
  )
  if (effectTier() === "full") mountCachedImage(backdrop, logoUrl, "logo")

  const foreground = document.createElement("img")
  foreground.alt = ""
  foreground.loading = "lazy"
  foreground.decoding = "async"
  foreground.className = "absolute inset-0 m-auto max-h-[60%] max-w-[60%] object-contain"
  mountCachedImage(foreground, logoUrl, "logo")

  return [backdrop, foreground]
}

function createLiveCard(item: LiveCardItem, options?: CardRenderOptions): HTMLButtonElement {
  const card = document.createElement("button")
  card.type = "button"
  card.dataset.focusKey = cardFocusKey(item.railId, item.kind, item.id)
  card.dataset.entryKey = cardEntryKey(item)
  card.setAttribute("aria-label", item.ariaLabel)
  const widthClass = options?.fill ? "w-full" : "w-[9.5rem] shrink-0"
  card.className = `flex ${widthClass} flex-col gap-2 rounded-xl text-left ${CARD_FOCUS_CLASSES}`

  const tileWrap = document.createElement("div")
  tileWrap.dataset.posterWrap = "1"
  tileWrap.dataset.imageUrl = item.logoUrl || ""
  tileWrap.className =
    "relative isolate aspect-[2/3] w-full overflow-hidden rounded-xl bg-black/40 tv-edge-mask"
  tileWrap.append(...buildLiveTile(item.logoUrl, item.name))
  card.appendChild(tileWrap)

  const title = document.createElement("div")
  title.dataset.cardTitle = "1"
  title.className = "tv-card-title truncate text-sm font-medium text-fg-2"
  title.textContent = item.name

  const meta = document.createElement("div")
  meta.dataset.cardMeta = "1"
  meta.className = "truncate text-xs text-fg-3"
  meta.textContent = item.nowTitle

  card.append(title, meta)
  if (item.logoUrl) card.dataset.prefetchUrl = item.logoUrl
  wireCardActivation(card, null, item.onActivate, item.onLongPress)
  return card
}

function updateLiveCard(card: HTMLButtonElement, item: LiveCardItem): void {
  card.setAttribute("aria-label", item.ariaLabel)
  if (item.logoUrl) card.dataset.prefetchUrl = item.logoUrl
  else delete card.dataset.prefetchUrl

  const tileWrap = card.querySelector<HTMLElement>("[data-poster-wrap]")
  if (tileWrap && tileWrap.dataset.imageUrl !== (item.logoUrl || "")) {
    tileWrap.dataset.imageUrl = item.logoUrl || ""
    tileWrap.replaceChildren(...buildLiveTile(item.logoUrl, item.name))
  }

  const title = card.querySelector<HTMLElement>("[data-card-title]")
  if (title) title.textContent = item.name
  const meta = card.querySelector<HTMLElement>("[data-card-meta]")
  if (meta) meta.textContent = item.nowTitle

  updateCardBehavior(card, null, item.onActivate, item.onLongPress)
}

export function createCard(item: CardItem, options?: CardRenderOptions): HTMLAnchorElement | HTMLButtonElement {
  return item.kind === "live" ? createLiveCard(item, options) : createPosterCard(item, options)
}

/** Patches a reused card in place (title/meta/progress/behavior); re-mounts the image only if its URL changed. */
export function updateCard(card: HTMLElement, item: CardItem): void {
  if (item.kind === "live") updateLiveCard(card as HTMLButtonElement, item)
  else updatePosterCard(card as HTMLAnchorElement, item)
}
