// Shared TV home-rail card: 2:3 poster footprint for VOD/series/episode/live.

import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { makeFallback } from "@/scripts/lib/entry-card.ts"

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
}

export interface LiveCardItem extends CardItemBase {
  kind: "live"
  logoUrl: string | null
  nowTitle: string
  ariaLabel: string
  onActivate: () => void
}

export type CardItem = PosterCardItem | LiveCardItem

export function cardFocusKey(railId: string, kind: CardKind, id: string | number): string {
  return `${railId}:${kind}:${id}`
}

const CARD_FOCUS_CLASSES = "self-start outline-none transition-transform tv-focus-card"

function createPosterCard(item: PosterCardItem): HTMLAnchorElement {
  const card = document.createElement("a")
  card.href = item.href
  card.dataset.focusKey = cardFocusKey(item.railId, item.kind, item.id)
  card.setAttribute("aria-label", item.ariaLabel)
  card.className = `flex w-[11.5rem] shrink-0 flex-col gap-2 rounded-xl ${CARD_FOCUS_CLASSES}`

  const posterWrap = document.createElement("div")
  posterWrap.dataset.posterWrap = "1"
  posterWrap.className = "relative aspect-[2/3] w-full overflow-hidden rounded-xl tv-clip-round bg-black/40"

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
  meta.className = "truncate text-xs text-fg-3"
  meta.textContent = item.meta

  card.append(posterWrap, title, meta)
  return card
}

function createLiveCard(item: LiveCardItem): HTMLButtonElement {
  const card = document.createElement("button")
  card.type = "button"
  card.dataset.focusKey = cardFocusKey(item.railId, item.kind, item.id)
  card.setAttribute("aria-label", item.ariaLabel)
  card.className = `flex w-[11.5rem] shrink-0 flex-col gap-2 rounded-xl text-left ${CARD_FOCUS_CLASSES}`

  const tileWrap = document.createElement("div")
  tileWrap.dataset.posterWrap = "1"
  tileWrap.className = "relative aspect-[2/3] w-full overflow-hidden rounded-xl tv-clip-round bg-black/40"

  if (item.logoUrl) {
    const backdrop = document.createElement("img")
    backdrop.alt = ""
    backdrop.setAttribute("aria-hidden", "true")
    backdrop.loading = "lazy"
    backdrop.decoding = "async"
    backdrop.className =
      "absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-2xl saturate-150"
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
  card.addEventListener("click", () => item.onActivate())
  return card
}

export function createCard(item: CardItem): HTMLAnchorElement | HTMLButtonElement {
  return item.kind === "live" ? createLiveCard(item) : createPosterCard(item)
}
