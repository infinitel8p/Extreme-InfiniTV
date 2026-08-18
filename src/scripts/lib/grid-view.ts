// Shared grid-page behavior for the movies and series listing bundles.
import { xtreamApiFetch } from "@/scripts/lib/xtream-api.js"
import {
  isFavorite,
  toggleFavorite,
  isOnWatchlist,
  toggleWatchlist,
  getHideWatched,
  setHideWatched,
  getLanguageFilter,
  setLanguageFilter,
  getGroupLanguages,
  setGroupLanguages,
} from "@/scripts/lib/preferences.js"
import { t } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import { resolvePersonTitleIds } from "@/scripts/lib/person-filter.ts"
import type { TmdbCatalogEntry } from "@/scripts/lib/tmdb-match.ts"
import {
  saveGridState,
  takeGridState,
  gridStateMatchesLocation,
  type GridStatePage,
  type GridState,
  type GridPersonSignature,
} from "@/scripts/lib/grid-state.ts"
import { fmtElapsedMs } from "@/scripts/lib/format.ts"
import { getLanguageGroupingEnabled } from "@/scripts/lib/app-settings.js"

export type ContentKind = "vod" | "series"

export { fmtElapsedMs as fmtAge }

// ----------------------------
// Poster skeleton placeholders
// ----------------------------
export interface PosterSkeletonGeometry {
  cols: number
  count: number
}

export function posterSkeletonGeometry(): PosterSkeletonGeometry {
  const width = typeof window !== "undefined" ? window.innerWidth || 1280 : 1280
  const height = typeof window !== "undefined" ? window.innerHeight || 720 : 720
  const cardWidth = width >= 1024 ? 176 : width >= 640 ? 160 : 128
  const cardHeight = cardWidth * 1.7
  const cols = Math.max(2, Math.floor((width - 48) / (cardWidth + 16)))
  const rows = Math.max(2, Math.ceil(height / cardHeight) + 1)
  const count = Math.min(48, cols * rows)
  return { cols, count }
}

export function posterSkeletonCount(): number {
  return posterSkeletonGeometry().count
}

export function renderPosterSkeletons(target: HTMLElement | null, count?: number): void {
  if (!target) return
  const geometry = posterSkeletonGeometry()
  const total = Number.isFinite(count) && (count as number) > 0 ? (count as number) : geometry.count
  const cols = geometry.cols || 4
  const frag = document.createDocumentFragment()
  for (let i = 0; i < total; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    // Diagonal wave
    const waveDelay = (col * 90 + row * 140) % 1600
    // Soft entrance stagger, cap at 8 cards
    const enterDelay = Math.min(i, 8) * 28

    const card = document.createElement("div")
    card.dataset.skeleton = "true"
    card.className = "rounded-xl overflow-hidden ring-1 ring-line bg-surface-2"
    card.style.setProperty("--skel-delay", `${waveDelay}ms`)
    card.style.setProperty("--skel-enter-delay", `${enterDelay}ms`)
    card.innerHTML =
      `<div class="aspect-2/3 w-full skel" style="--skel-delay:${waveDelay}ms;"></div>
       <div class="px-2 py-2 flex flex-col gap-1.5">
         <div class="h-3 rounded skel" style="width:${60 + ((i * 7) % 35)}%; --skel-delay:${waveDelay + 80}ms;"></div>
         <div class="h-2.5 rounded skel" style="width:${30 + ((i * 5) % 30)}%; --skel-delay:${waveDelay + 160}ms;"></div>
       </div>`
    frag.appendChild(card)
  }
  target.replaceChildren(frag)
}

// ----------------------------
// Category maps
// ----------------------------
export async function fetchCategoryMap(
  action: "get_vod_categories" | "get_series_categories"
): Promise<Map<string, string>> {
  const response = await xtreamApiFetch(action)
  const data = await response.json().catch(() => [])
  const arr: Array<{ category_id?: unknown; category_name?: unknown }> = Array.isArray(data)
    ? data
    : Array.isArray(data?.categories)
      ? data.categories
      : []
  return new Map(
    arr
      .filter((category) => category && category.category_id != null)
      .map((category) => [String(category.category_id), String(category.category_name || "").trim()])
  )
}

// ----------------------------
// Favorite / watchlist state across language-variant groups
// ----------------------------
export interface VariantGroup {
  globalEntryIds: number[]
  entries: Array<{ id: number; name?: string; logo?: string | null }>
}

// preferences.js's favorite/watchlist JSDoc kind unions are inconsistent across
// functions ("live"|"vod" here, "vod"|"series" there); "vod"|"series" works at runtime.
function asPreferenceKind(contentKind: ContentKind): any {
  return contentKind
}

export function groupHasFavorite(playlistId: string, contentKind: ContentKind, group: VariantGroup): boolean {
  const kind = asPreferenceKind(contentKind)
  return playlistId ? group.globalEntryIds.some((id) => isFavorite(playlistId, kind, id)) : false
}

export function groupHasWatchlist(playlistId: string, contentKind: ContentKind, group: VariantGroup): boolean {
  const kind = asPreferenceKind(contentKind)
  return playlistId ? group.globalEntryIds.some((id) => isOnWatchlist(playlistId, kind, id)) : false
}

export function toggleGroupFavorite(
  playlistId: string,
  contentKind: ContentKind,
  group: VariantGroup,
  fallbackEntry: { name?: string; logo?: string | null },
  currentlyFavorited: boolean
): void {
  if (!playlistId) return
  const kind = asPreferenceKind(contentKind)
  if (!currentlyFavorited) {
    for (const variantId of group.globalEntryIds) {
      if (isFavorite(playlistId, kind, variantId)) continue
      const variantEntry = group.entries.find((entry) => entry.id === variantId) || fallbackEntry
      toggleFavorite(playlistId, kind, variantId, {
        name: variantEntry.name || "",
        logo: variantEntry.logo || null,
      })
    }
    return
  }
  for (const variantId of group.globalEntryIds) {
    if (isFavorite(playlistId, kind, variantId)) {
      toggleFavorite(playlistId, kind, variantId)
    }
  }
}

export function toggleGroupWatchlist(
  playlistId: string,
  contentKind: ContentKind,
  group: VariantGroup,
  fallbackEntry: { name?: string; logo?: string | null },
  currentlyOnWatchlist: boolean
): void {
  if (!playlistId) return
  const kind = asPreferenceKind(contentKind)
  if (!currentlyOnWatchlist) {
    for (const variantId of group.globalEntryIds) {
      if (isOnWatchlist(playlistId, kind, variantId)) continue
      const variantEntry = group.entries.find((entry) => entry.id === variantId) || fallbackEntry
      toggleWatchlist(playlistId, kind, variantId, {
        name: variantEntry.name || "",
        logo: variantEntry.logo || null,
      })
    }
    return
  }
  for (const variantId of group.globalEntryIds) {
    if (isOnWatchlist(playlistId, kind, variantId)) {
      toggleWatchlist(playlistId, kind, variantId)
    }
  }
}

// ----------------------------
// Hide-watched / group-languages / language-filter toggle wiring
// ----------------------------
export interface GridSecondaryControlsOptions {
  contentKind: ContentKind
  hideWatchedButtonId: string
  groupLangsButtonId: string
  langFilterSelectId: string
  getActivePlaylistId: () => string
  applyFilter: () => void
  onHideWatchedEnabled?: () => Promise<void> | void
}

export interface GridSecondaryControls {
  langFilterEl: HTMLSelectElement | null
  syncHideWatchedControl: () => void
  syncGroupLangsControl: () => void
  syncLangFilterControl: () => void
}

export function createGridSecondaryControls(options: GridSecondaryControlsOptions): GridSecondaryControls {
  const contentKind = options.contentKind

  const hideWatchedBtn = document.getElementById(options.hideWatchedButtonId)
  function syncHideWatchedControl(): void {
    const playlistId = options.getActivePlaylistId()
    if (!hideWatchedBtn || !playlistId) return
    hideWatchedBtn.setAttribute("aria-checked", String(getHideWatched(playlistId, contentKind)))
  }
  // Delegated on document so sort-menu.ts's own handler flips aria-checked first.
  document.addEventListener("click", async (event) => {
    const playlistId = options.getActivePlaylistId()
    if (!hideWatchedBtn || !playlistId) return
    if (!(event.target instanceof Node) || !hideWatchedBtn.contains(event.target)) return
    const next = hideWatchedBtn.getAttribute("aria-checked") === "true"
    setHideWatched(playlistId, contentKind, next)
    if (next && options.onHideWatchedEnabled) await options.onHideWatchedEnabled()
    options.applyFilter()
  })

  const groupLangsBtn = document.getElementById(options.groupLangsButtonId)
  // The global setting makes the per-playlist toggle meaningless when off, so hide it entirely.
  if (groupLangsBtn) groupLangsBtn.hidden = !getLanguageGroupingEnabled()
  function syncGroupLangsControl(): void {
    if (!groupLangsBtn) return
    groupLangsBtn.hidden = !getLanguageGroupingEnabled()
    const playlistId = options.getActivePlaylistId()
    if (!playlistId) return
    groupLangsBtn.setAttribute("aria-checked", String(getGroupLanguages(playlistId, contentKind)))
  }
  document.addEventListener("click", (event) => {
    const playlistId = options.getActivePlaylistId()
    if (!groupLangsBtn || !playlistId) return
    if (!(event.target instanceof Node) || !groupLangsBtn.contains(event.target)) return
    const next = groupLangsBtn.getAttribute("aria-checked") === "true"
    setGroupLanguages(playlistId, contentKind, next)
    options.applyFilter()
  })

  const langFilterEl = document.getElementById(options.langFilterSelectId) as HTMLSelectElement | null
  function syncLangFilterControl(): void {
    const playlistId = options.getActivePlaylistId()
    if (!langFilterEl || !playlistId) return
    langFilterEl.value = getLanguageFilter(playlistId, contentKind)
  }
  langFilterEl?.addEventListener("change", () => {
    const playlistId = options.getActivePlaylistId()
    if (!playlistId || !langFilterEl) return
    setLanguageFilter(playlistId, contentKind, langFilterEl.value)
    options.applyFilter()
  })

  return { langFilterEl, syncHideWatchedControl, syncGroupLangsControl, syncLangFilterControl }
}

// ----------------------------
// Person filter (cast/crew chip from a detail page)
// ----------------------------
export interface PersonFilterSignature {
  name: string
  tmdbId: number | null
}

export function parsePersonFilterFromSearch(search: string): PersonFilterSignature | null {
  const params = new URLSearchParams(search)
  const name = params.get("person")
  if (!name) return null
  const tmdbId = Number(params.get("personId"))
  return { name, tmdbId: Number.isFinite(tmdbId) && tmdbId > 0 ? tmdbId : null }
}

// Renamed to the grid-state schema's field names for saveGridState/takeGridState.
export function personFilterGridSignature(search: string): GridPersonSignature | null {
  const parsed = parsePersonFilterFromSearch(search)
  return parsed ? { person: parsed.name, personId: parsed.tmdbId } : null
}

function stripPersonFilterFromUrl(): void {
  const params = new URLSearchParams(location.search)
  params.delete("person")
  params.delete("personId")
  const next = params.toString()
  history.replaceState(null, "", location.pathname + (next ? `?${next}` : ""))
}

export interface PersonFilterControllerOptions {
  contentKind: ContentKind
  rowId: string
  labelId: string
  clearButtonId: string
  logTag: string
  getActivePlaylistId: () => string
  getCatalogEntries: () => TmdbCatalogEntry[]
  applyFilter: () => void
}

export interface PersonFilterController {
  isActive: () => boolean
  getTitleIds: () => Set<number> | null
  guardUnresolved: () => boolean
  clear: () => void
  render: () => void
}

export function createPersonFilterController(options: PersonFilterControllerOptions): PersonFilterController {
  let active = false
  let name = ""
  let tmdbId: number | null = null
  // null while inactive or unresolved; a resolved miss is an empty Set.
  let titleIds: Set<number> | null = null
  let inFlight = false
  let token = 0

  const row = document.getElementById(options.rowId)
  const label = document.getElementById(options.labelId)

  function render(): void {
    if (!row || !label) return
    if (!active) {
      row.setAttribute("hidden", "")
      return
    }
    label.textContent = t("list.personFilter", { name })
    row.removeAttribute("hidden")
  }

  function deactivate(): void {
    active = false
    name = ""
    tmdbId = null
    titleIds = null
    stripPersonFilterFromUrl()
    render()
  }

  function clear(): void {
    if (!active) return
    token++
    deactivate()
    options.applyFilter()
  }

  // Resolved once per activation; a later paint (SWR revalidation, cache hit) is a no-op once settled.
  function ensureResolved(): void {
    if (!active || titleIds !== null || inFlight) return
    inFlight = true
    const runToken = ++token
    let resolutionFailed = false
    resolvePersonTitleIds({
      kind: options.contentKind,
      playlistId: options.getActivePlaylistId(),
      personName: name,
      tmdbPersonId: tmdbId,
      catalogEntries: options.getCatalogEntries(),
    })
      .then((ids) => {
        if (runToken === token) titleIds = ids
      })
      .catch((error) => {
        log.warn(`[${options.logTag}] person filter resolution failed:`, error)
        resolutionFailed = true
      })
      .finally(() => {
        inFlight = false
        if (runToken !== token) return
        // Both sources failed outright: degrade silently to the unfiltered grid rather
        // than getting stuck. A legitimate zero-match resolution keeps the pill + empty state.
        if (resolutionFailed) deactivate()
        options.applyFilter()
      })
  }

  // While unresolved, the caller must defer rendering entirely so the grid never flashes unfiltered.
  function guardUnresolved(): boolean {
    if (active && titleIds === null) {
      ensureResolved()
      return true
    }
    return false
  }

  document.getElementById(options.clearButtonId)?.addEventListener("click", clear)

  const initial = parsePersonFilterFromSearch(location.search)
  if (initial) {
    active = true
    name = initial.name
    tmdbId = initial.tmdbId
  }

  return {
    isActive: () => active,
    getTitleIds: () => titleIds,
    guardUnresolved,
    clear,
    render,
  }
}

// ----------------------------
// Grid state restore (back-navigation from a detail page)
// ----------------------------
function isRestoreNavigation(): boolean {
  try {
    const navigationEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
    const navigationType = navigationEntry?.type
    return navigationType === "back_forward" || navigationType === "reload"
  } catch {
    return false
  }
}

export interface GridRestoreOptions {
  routeKind: GridStatePage
  pageSize: number
  getActivePlaylistId: () => string
  getGridEl: () => HTMLElement | null
  getSearchEl: () => HTMLInputElement | null
  getFilteredLength: () => number
  getRenderedCount: () => number
  appendNextPage: () => void
  getPersonSignature: () => GridPersonSignature | null
}

export interface GridRestoreController {
  attemptRestore: () => void
  consumePending: () => void
  reset: () => void
}

export function createGridRestoreController(options: GridRestoreOptions): GridRestoreController {
  let pendingGridState: GridState | null = null
  let restoreAttempted = false

  function attemptRestore(): void {
    if (restoreAttempted) return
    restoreAttempted = true
    if (!isRestoreNavigation()) return
    const candidate = takeGridState(options.routeKind, options.getActivePlaylistId())
    if (!candidate || !gridStateMatchesLocation(candidate, location.search)) return
    pendingGridState = candidate
    const searchEl = options.getSearchEl()
    if (searchEl) searchEl.value = candidate.search
  }

  function extendRenderedCountTo(target: number): void {
    const cappedTarget = Math.min(target, options.getFilteredLength())
    while (options.getRenderedCount() < cappedTarget) {
      const before = options.getRenderedCount()
      options.appendNextPage()
      if (options.getRenderedCount() === before) break
    }
  }

  function captureScrollY(): number {
    const gridEl = options.getGridEl()
    const windowY = typeof window !== "undefined" ? window.scrollY || 0 : 0
    const gridY = gridEl ? gridEl.scrollTop || 0 : 0
    return Math.max(windowY, gridY)
  }

  // The grid section owns its own overflow-auto scroll; restore both it and
  // the window in case a layout has the page itself scrolling instead.
  function restoreScrollY(scrollY: number): void {
    window.scrollTo(0, scrollY)
    const gridEl = options.getGridEl()
    if (gridEl) gridEl.scrollTop = scrollY
  }

  function scheduleScrollRestore(scrollY: number): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        restoreScrollY(scrollY)
      })
    })
  }

  // Runs once the grid has actually rendered the settled (filtered) result,
  // so the extra pages append before the browser paints - no page-1-then-jump flash.
  function consumePending(): void {
    if (!pendingGridState) return
    const state = pendingGridState
    pendingGridState = null
    extendRenderedCountTo(state.renderedCount)
    scheduleScrollRestore(state.scrollY)
  }

  function currentSnapshot(): GridState {
    return {
      search: options.getSearchEl()?.value || "",
      renderedCount: options.getRenderedCount(),
      scrollY: captureScrollY(),
      personSignature: options.getPersonSignature(),
    }
  }

  function isDefaultState(state: GridState): boolean {
    return !state.search && state.renderedCount <= options.pageSize && state.scrollY < 100
  }

  window.addEventListener("pagehide", () => {
    const playlistId = options.getActivePlaylistId()
    if (!playlistId) return
    const state = currentSnapshot()
    if (isDefaultState(state)) return
    saveGridState(options.routeKind, playlistId, state)
  })

  return {
    attemptRestore,
    consumePending,
    reset: () => {
      pendingGridState = null
    },
  }
}
