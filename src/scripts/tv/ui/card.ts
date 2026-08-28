// Shared TV home-rail card: 2:3 poster footprint for VOD/series/episode/live.

import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { makeFallback } from "@/scripts/lib/entry-card.ts"
import { fmtImdbRating } from "@/scripts/lib/format.ts"
import { attachLongPress } from "@/scripts/tv/long-press.ts"
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
}

export function cardFocusKey(railId: string, kind: CardKind, id: string | number): string {
  return `${railId}:${kind}:${id}`
}

/** Shared movies/series card meta line: "year · rating", either half omitted when absent. */
export function formatCardMeta(year: unknown, rating: unknown): string {
  const yearText = String(year ?? "").match(/\d{4}/)?.[0] || ""
  const ratingText = fmtImdbRating(rating)
  return [yearText, ratingText].filter(Boolean).join(" · ")
}

const CARD_FOCUS_CLASSES = "self-start outline-none tv-focus-card"

/** Wires activation (click/Enter) and, when given, a long-press action sheet trigger. */
function wireCardActivation(
  card: HTMLElement,
  href: string | null,
  onActivate: (() => void) | undefined,
  onLongPress: (() => void) | undefined
): void {
  // Must stay a ClientRouter navigation: a full load skips the swap events focus memory rides on.
  const activate = onActivate ?? (href ? () => { void navigate(href) } : undefined)
  if (onLongPress) {
    attachLongPress<HTMLElement>({
      container: card,
      targetSelector: "[data-focus-key]",
      resolveTarget: () => card,
      onActivate: () => activate?.(),
      onLongPress,
    })
    return
  }
  if (onActivate) {
    card.addEventListener("click", (event) => {
      event.preventDefault()
      onActivate()
    })
  }
}

function createPosterCard(item: PosterCardItem, options?: CardRenderOptions): HTMLAnchorElement {
  const card = document.createElement("a")
  card.href = item.href
  card.dataset.focusKey = cardFocusKey(item.railId, item.kind, item.id)
  card.setAttribute("aria-label", item.ariaLabel)
  const widthClass = options?.fill ? "w-full" : "w-[9.5rem] shrink-0"
  card.className = `flex ${widthClass} flex-col gap-2 rounded-xl ${CARD_FOCUS_CLASSES}`

  const posterWrap = document.createElement("div")
  posterWrap.dataset.posterWrap = "1"
  posterWrap.className =
    "relative isolate aspect-[2/3] w-full overflow-hidden rounded-xl bg-black/40 tv-edge-mask"

  if (item.posterUrl) {
    const img = document.createElement("img")
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    img.className = "block h-full w-full object-cover"
    posterWrap.appendChild(img)
    mountCachedImage(img, item.posterUrl, "poster")
  } else {
    posterWrap.appendChild(makeFallback(item.name))
  }

  if (item.progressPercent != null && item.progressPercent > 0) {
    const progressTrack = document.createElement("div")
    progressTrack.className = "absolute inset-x-0 bottom-0 h-1 bg-black/55"
    const progressFill = document.createElement("div")
    progressFill.className = "h-full bg-accent"
    progressFill.style.width = `${Math.max(0, Math.min(100, item.progressPercent))}%`
    progressTrack.appendChild(progressFill)
    posterWrap.appendChild(progressTrack)
  }

  const title = document.createElement("div")
  title.className = "tv-card-title truncate text-sm font-medium text-fg-2"
  title.textContent = item.name

  const meta = document.createElement("div")
  meta.className = "min-h-4 truncate text-xs text-fg-3"
  meta.textContent = item.meta

  card.append(posterWrap, title, meta)
  wireCardActivation(card, item.href, item.onActivate, item.onLongPress)
  return card
}

function createLiveCard(item: LiveCardItem, options?: CardRenderOptions): HTMLButtonElement {
  const card = document.createElement("button")
  card.type = "button"
  card.dataset.focusKey = cardFocusKey(item.railId, item.kind, item.id)
  card.setAttribute("aria-label", item.ariaLabel)
  const widthClass = options?.fill ? "w-full" : "w-[9.5rem] shrink-0"
  card.className = `flex ${widthClass} flex-col gap-2 rounded-xl text-left ${CARD_FOCUS_CLASSES}`

  const tileWrap = document.createElement("div")
  tileWrap.dataset.posterWrap = "1"
  tileWrap.className =
    "relative isolate aspect-[2/3] w-full overflow-hidden rounded-xl bg-black/40 tv-edge-mask"

  if (item.logoUrl) {
    const backdrop = document.createElement("img")
    backdrop.alt = ""
    backdrop.setAttribute("aria-hidden", "true")
    backdrop.loading = "lazy"
    backdrop.decoding = "async"
    backdrop.className =
      "absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-2xl saturate-150"
    tileWrap.appendChild(backdrop)
    mountCachedImage(backdrop, item.logoUrl, "logo")

    const foreground = document.createElement("img")
    foreground.alt = ""
    foreground.loading = "lazy"
    foreground.decoding = "async"
    foreground.className = "absolute inset-0 m-auto max-h-[60%] max-w-[60%] object-contain"
    tileWrap.appendChild(foreground)
    mountCachedImage(foreground, item.logoUrl, "logo")
  } else {
    tileWrap.appendChild(makeFallback(item.name))
  }

  card.appendChild(tileWrap)

  const title = document.createElement("div")
  title.className = "tv-card-title truncate text-sm font-medium text-fg-2"
  title.textContent = item.name

  const meta = document.createElement("div")
  meta.className = "truncate text-xs text-fg-3"
  meta.textContent = item.nowTitle

  card.append(title, meta)
  wireCardActivation(card, null, item.onActivate, item.onLongPress)
  return card
}

export function createCard(item: CardItem, options?: CardRenderOptions): HTMLAnchorElement | HTMLButtonElement {
  return item.kind === "live" ? createLiveCard(item, options) : createPosterCard(item, options)
}
