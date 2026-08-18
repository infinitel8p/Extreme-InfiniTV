// Shared poster-card builder for /movies and /series.
//
// Both pages render an identical card shell: 2:3 poster, optional rating
// pill, optional watchlist bookmark, optional progress badge, name +
// meta line, hover star toggle. Only the kind ("vod" | "series"), the
// detail-page href, and the meta text differ per page. This module owns
// the markup so the two callers don't drift.

import { t } from "@/scripts/lib/i18n.js"
import { fmtImdbRating } from "@/scripts/lib/format.js"
import { ICON_CHECK } from "@/scripts/lib/icons.js"
import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { languageTagLabel } from "@/scripts/lib/language-tags.ts"
import {
  isFavorite,
  toggleFavorite,
  isOnWatchlist,
} from "@/scripts/lib/preferences.js"

// ---------------------------------------------------------------------------
// SVG icon constants - exported so movies.ts / series.ts can patch the star
// in-place when a favorite toggles without re-rendering the card.
// ---------------------------------------------------------------------------
export const STAR_OUTLINE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/></svg>'

export const STAR_FILLED =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/></svg>'

export const BOOKMARK_FILLED =
  '<svg xmlns="http://www.w3.org/2000/svg" width="0.85em" height="0.85em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 3a2 2 0 0 0-2 2v16l8-4 8 4V5a2 2 0 0 0-2-2H6z"/></svg>'

export const WATCHED_BADGE_CLASS = "entry-watched-badge"

/** Small check badge for a fully-watched movie/series, same slot as the series progress badge. */
export function buildWatchedBadge(): HTMLSpanElement {
  const badge = document.createElement("span")
  badge.className =
    `${WATCHED_BADGE_CLASS} absolute bottom-1.5 right-1.5 inline-flex items-center justify-center ` +
    "rounded-md px-1.5 py-0.5 bg-accent text-bg text-2xs ring-1 ring-black/10"
  badge.setAttribute("aria-label", t("list.watchedBadge"))
  badge.title = t("list.watchedBadge")
  badge.innerHTML = ICON_CHECK
  return badge
}

export const LANGUAGE_CHIPS_CLASS = "entry-language-chips"

/** Bottom-right language pill for a grouped card (tag + overflow, or a variant count); null when there's nothing to show. */
export function buildLanguageChips(
  tags: string[],
  variantCount: number,
  locale: string,
  displayTag?: string | null
): HTMLSpanElement | null {
  const showTags = tags.length >= 2
  const showCount = !showTags && variantCount > 1
  if (!showTags && !showCount) return null

  const chip = document.createElement("span")
  chip.className =
    `${LANGUAGE_CHIPS_CLASS} absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 ` +
    "rounded-md px-1.5 py-0.5 bg-black/55 backdrop-blur-sm " +
    "ring-1 ring-white/10 text-white/90 text-2xs font-semibold tabular-nums"

  if (showTags) {
    const featuredTag = displayTag && tags.includes(displayTag) ? displayTag : tags[0]
    chip.textContent = `${featuredTag} +${tags.length - 1}`
    chip.title = tags.map((tag) => languageTagLabel(tag, locale)).join(", ")
  } else {
    chip.textContent = `x${variantCount}`
  }
  return chip
}

/** Keeps the language pill from overlapping the watched/progress badge, which shares the bottom-right corner. */
export function setLanguageChipsOffset(posterWrap: HTMLElement, badgePresent: boolean): void {
  const chips = posterWrap.querySelector(`.${LANGUAGE_CHIPS_CLASS}`)
  if (!chips) return
  chips.classList.toggle("bottom-8", badgePresent)
  chips.classList.toggle("bottom-1.5", !badgePresent)
}

// ---------------------------------------------------------------------------
// Fallback poster (image failed / missing). Used by both pages when an
// image errors out, exposed so the existing onerror handlers don't have
// to reach into this module.
// ---------------------------------------------------------------------------
export function makeFallback(name?: string | null): HTMLDivElement {
  const fb = document.createElement("div")
  fb.className =
    "h-full w-full flex items-center justify-center text-center px-3 " +
    "text-fg-3 text-xs tracking-wide bg-gradient-to-br from-surface-2 to-surface-3"
  fb.textContent = name || t("list.noPosterFallback")
  return fb
}

export type EntryKind = "vod" | "series"

export interface EntryLike {
  id: string | number
  name?: string | null
  logo?: string | null
  rating?: unknown
  year?: string | number | null
  category?: string | null
}

export interface BuildEntryCardOptions<T extends EntryLike> {
  /** The entry being rendered. */
  entry: T
  /** Position in the visible grid. Used for stagger animation timing. */
  idx: number
  /** Which favorite/watchlist namespace to use. */
  kind: EntryKind
  /** Active playlist id - empty string disables the favorite toggle. */
  activePlaylistId: string
  /** Builds the detail-page href for this entry. */
  detailHref: (entry: T) => string
  /** Title shown when the entry has no name. */
  fallbackTitle: (entry: T) => string
  /** Right-hand caption under the title (e.g. "2024 • 2h 14m • Drama"). */
  metaText: (entry: T) => string
  /**
   * Optional hook to add extra absolutely-positioned children to the
   * poster wrapper (e.g. the series-progress badge). Called after the
   * built-in rating / watch badges.
   */
  decoratePoster?: (posterWrap: HTMLDivElement, entry: T) => void
  /** aria-label for the star button when not yet favorited. */
  starLabel?: (entry: T, fav: boolean) => string
  /** Opt-in group-aware favorite state, overriding the default `isFavorite` lookup. */
  favoriteState?: (entry: T) => boolean
  /** Opt-in group-aware favorite toggle, overriding the default `toggleFavorite` call. */
  onToggleFavorite?: (entry: T, currentlyFavorited: boolean) => void
  /** Opt-in group-aware watchlist state, overriding the default `isOnWatchlist` lookup. */
  watchlistState?: (entry: T) => boolean
  /**
   * Right-click / long-press handler. When provided, wires the shared poster
   * context menu (`poster-menu.ts`) so users get Open / Favorite / Watchlist
   * (and Download / Copy URL on movies). Omit to leave the card with
   * default browser menu behaviour.
   */
  onContextMenu?: (
    entry: T,
    anchor: HTMLElement,
    point: { x: number; y: number } | null
  ) => void
}

const DEFAULT_STAR_LABEL = (entry: EntryLike, fav: boolean): string => {
  const name = entry.name || (typeof entry.id === "string" ? entry.id : `#${entry.id}`)
  return fav ? `Remove ${name} from favorites` : `Add ${name} to favorites`
}

/**
 * Build a poster card matching the existing /movies and /series grid
 * design. Returns the root <div> ready to append.
 */
export function buildEntryCard<T extends EntryLike>(
  opts: BuildEntryCardOptions<T>
): HTMLDivElement {
  const {
    entry,
    idx,
    kind,
    activePlaylistId,
    detailHref,
    fallbackTitle,
    metaText,
    decoratePoster,
    starLabel = DEFAULT_STAR_LABEL,
    favoriteState,
    onToggleFavorite,
    watchlistState,
    onContextMenu,
  } = opts

  const card = document.createElement("div")
  card.dataset.idx = String(idx)
  const stagger = idx < 12
  card.className =
    "movie-card group relative rounded-xl overflow-hidden bg-surface-2 " +
    "ring-1 ring-line " +
    "transition-[transform,box-shadow] duration-150 " +
    "hover:ring-1 hover:ring-accent hover:[transform:translateY(-2px)] " +
    "focus-within:ring-1 focus-within:ring-accent focus-within:[transform:translateY(-2px)]" +
    (stagger ? " grid-card-enter" : "")
  if (stagger) card.style.animationDelay = `${idx * 28}ms`
  card.style.contentVisibility = "auto"
  card.style.containIntrinsicSize = "260px"

  const link = document.createElement("a")
  link.href = detailHref(entry)
  link.dataset.role = "play"
  link.className =
    "play-btn block w-full text-left outline-none cursor-pointer no-underline"
  link.title = entry.name || ""
  link.setAttribute(
    "aria-label",
    t("list.openAria", { name: entry.name || fallbackTitle(entry) })
  )

  // Cross-document view-transition handoff for the poster image.
  link.addEventListener("click", () => {
    const img = link.querySelector("img")
    if (img) (img as HTMLElement).style.viewTransitionName = "active-poster"
  })

  const posterWrap = document.createElement("div")
  posterWrap.dataset.posterWrap = "1"
  posterWrap.className =
    "logo-skel aspect-[2/3] w-full bg-surface-2 overflow-hidden relative"

  if (entry.logo) {
    const img = document.createElement("img")
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    ;(img as any).fetchPriority = "low"
    img.referrerPolicy = "no-referrer"
    img.width = 200
    img.height = 300
    img.className =
      "h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
    img.onload = () => {
      posterWrap.dataset.loaded = "true"
    }
    img.onerror = () => {
      img.remove()
      posterWrap.appendChild(makeFallback(entry.name))
      posterWrap.dataset.loaded = "true"
    }
    posterWrap.appendChild(img)
    mountCachedImage(img, entry.logo, "poster")
  } else {
    posterWrap.appendChild(makeFallback(entry.name))
    posterWrap.dataset.loaded = "true"
  }

  const ratingText = fmtImdbRating(entry.rating as any)
  if (ratingText) {
    const ratingBadge = document.createElement("span")
    ratingBadge.className =
      "absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 " +
      "rounded-md px-1.5 py-0.5 bg-black/55 backdrop-blur-sm " +
      "ring-1 ring-white/10 text-white/90 text-2xs font-semibold tabular-nums"
    ratingBadge.setAttribute(
      "aria-label",
      t("list.ratingAria", { rating: ratingText })
    )
    ratingBadge.innerHTML =
      '<svg viewBox="0 0 24 24" width="0.85em" height="0.85em" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" class="text-accent">' +
      '<path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/>' +
      "</svg>" +
      `<span>${ratingText}</span>`
    posterWrap.appendChild(ratingBadge)
  }

  // Page-specific extras (e.g. series progress badge) before the
  // watchlist bookmark so the bookmark stays in the top-left corner.
  if (decoratePoster) decoratePoster(posterWrap, entry)

  const onWatchlist = activePlaylistId
    ? watchlistState
      ? watchlistState(entry)
      : isOnWatchlist(activePlaylistId, kind, entry.id)
    : false
  const watchBadge = document.createElement("span")
  watchBadge.dataset.role = "watch-badge"
  watchBadge.className =
    "absolute top-1.5 left-1.5 inline-flex items-center justify-center " +
    "size-6 rounded-md bg-black/55 backdrop-blur-sm ring-1 ring-white/10 " +
    "text-accent transition-opacity"
  watchBadge.setAttribute("aria-label", t("list.onWatchlist"))
  watchBadge.title = t("list.onWatchlist")
  watchBadge.innerHTML = BOOKMARK_FILLED
  if (!onWatchlist) watchBadge.hidden = true
  posterWrap.appendChild(watchBadge)

  link.appendChild(posterWrap)

  const info = document.createElement("div")
  info.className = "px-2 py-2 min-w-0"
  const nameEl = document.createElement("div")
  nameEl.className = "truncate text-sm font-medium text-fg"
  nameEl.textContent = entry.name || fallbackTitle(entry)
  const meta = document.createElement("div")
  meta.dataset.role = "meta"
  meta.className = "truncate text-2xs text-fg-3 tabular-nums"
  meta.textContent = metaText(entry)
  info.append(nameEl, meta)
  link.appendChild(info)

  card.appendChild(link)

  const getCurrentlyFavorited = (): boolean =>
    activePlaylistId
      ? favoriteState
        ? favoriteState(entry)
        : isFavorite(activePlaylistId, kind, entry.id)
      : false
  const fav = getCurrentlyFavorited()
  const starBtn = document.createElement("button")
  starBtn.type = "button"
  starBtn.dataset.role = "star"
  starBtn.className =
    "star-btn absolute top-2 right-2 h-8 w-8 rounded-lg outline-none " +
    "flex items-center justify-center text-base " +
    "bg-black/45 backdrop-blur-sm ring-1 ring-white/10 " +
    "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 " +
    "focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent " +
    "transition-opacity " +
    (fav ? "text-accent" : "text-white/85")
  if (fav) starBtn.classList.add("!opacity-100")
  starBtn.setAttribute("aria-label", starLabel(entry, fav))
  starBtn.setAttribute("aria-pressed", String(fav))
  starBtn.innerHTML = fav ? STAR_FILLED : STAR_OUTLINE
  starBtn.addEventListener("click", (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (!activePlaylistId) return
    // Re-check state at click time; a prior toggle only patches the DOM, not this closure.
    const currentlyFavorited = getCurrentlyFavorited()
    if (onToggleFavorite) {
      onToggleFavorite(entry, currentlyFavorited)
      return
    }
    toggleFavorite(activePlaylistId, kind, entry.id, {
      name: entry.name || "",
      logo: entry.logo || null,
    })
  })
  card.appendChild(starBtn)

  if (onContextMenu) {
    import("@/scripts/lib/poster-menu").then(({ attachPosterContextMenu }) => {
      attachPosterContextMenu(card, (anchor, point) =>
        onContextMenu(entry, anchor, point)
      )
    })
  }

  return card
}
