// Mounts the per-route view module into #tv-main's [data-tv-view-root] on every astro:page-load, tearing the previous one down on astro:before-swap.

import { releaseCachedImages } from "@/scripts/lib/img-cache.ts"
import { beginNavigationTransition, endNavigationTransition } from "@/scripts/tv/motion"

export const TV_VIEW_MOUNTED_EVENT = "xt:tv-view-mounted"

export interface TvViewContext {
  view: string
  url: URL
}

export interface TvView {
  mount(root: HTMLElement, ctx: TvViewContext): () => void
  /** Synchronous cache-first paint; returns true when it painted real content. */
  prepaint?(root: HTMLElement, url: URL): boolean
  /** Tears down a prepaint that mount never adopted. */
  releasePrepaint?(): void
}

type ViewLoader = () => Promise<{ default: TvView }>

const VIEW_LOADERS: Record<string, ViewLoader> = {
  home: () => import("./views/home"),
  live: () => import("./views/live"),
  movies: () => import("./views/movies"),
  "movies-detail": () => import("./views/movies-detail"),
  series: () => import("./views/series"),
  "series-detail": () => import("./views/series-detail"),
  search: () => import("./views/search"),
  downloads: () => import("./views/downloads"),
  settings: () => import("./views/settings"),
  login: () => import("./views/login"),
}

// Pathname of every /tv route, keyed to its VIEW_LOADERS entry - lets link-focus preloading
// resolve a module before the swap that will need it.
const PATH_TO_VIEW: Record<string, string> = {
  "/tv": "home",
  "/tv/live": "live",
  "/tv/movies": "movies",
  "/tv/movies/detail": "movies-detail",
  "/tv/series": "series",
  "/tv/series/detail": "series-detail",
  "/tv/search": "search",
  "/tv/downloads": "downloads",
  "/tv/settings": "settings",
  "/tv/login": "login",
}

let currentTeardown: (() => void) | null = null
let generation = 0

// Views resolved at least once, so a swap can prepaint synchronously instead of awaiting import().
const resolvedViewModules = new Map<string, TvView>()

/** Lets a view paint its skeleton before it starts catalog-sized work. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    requestAnimationFrame(() => setTimeout(done, 0))
    // A hidden document never runs rAF, and the view still has to load.
    setTimeout(done, 250)
  })
}

export interface OpenedEntryMark {
  kind: string
  id: string | number
}

// Set by a detail view when it opens; consumed once by the list view it returns to,
// so a back navigation can name the same card for the reverse morph.
let lastOpenedEntry: OpenedEntryMark | null = null

export function markLastOpenedEntry(mark: OpenedEntryMark): void {
  lastOpenedEntry = mark
}

export function takeLastOpenedEntry(): OpenedEntryMark | null {
  const mark = lastOpenedEntry
  lastOpenedEntry = null
  return mark
}

// An unadopted prepaint pins a detached view root, its cards and their decoded posters.
let prepaintedViewName: string | null = null

function releasePendingPrepaint(): void {
  const viewName = prepaintedViewName
  if (!viewName) return
  prepaintedViewName = null
  try {
    resolvedViewModules.get(viewName)?.releasePrepaint?.()
  } catch {}
}

function teardownCurrentView(): void {
  releasePendingPrepaint()
  const main = document.getElementById("tv-main")
  // Before teardown: a view that detaches its own root would take its images out of
  // `main` first, and they'd stay observed with their decoded bitmap resident.
  releaseCachedImages(main)
  if (currentTeardown) {
    try {
      currentTeardown()
    } catch {}
    currentTeardown = null
  }
  releaseCachedImages(main)
  generation++
}

// One module per idle slot: a nav should never wait on a chunk that could have been fetched while idle.
const WARMUP_ORDER = ["movies", "series", "search", "movies-detail", "series-detail"]
let warmupStarted = false

function warmViewModules(): void {
  if (warmupStarted) return
  warmupStarted = true
  const schedule =
    typeof window.requestIdleCallback === "function"
      ? (fn: () => void) => window.requestIdleCallback(fn, { timeout: 8000 })
      : (fn: () => void) => setTimeout(fn, 1500)
  const pending = WARMUP_ORDER.filter((view) => VIEW_LOADERS[view])
  const warmNext = (): void => {
    const view = pending.shift()
    if (!view) return
    VIEW_LOADERS[view]()
      .then((module) => resolvedViewModules.set(view, module.default))
      .catch(() => {})
      .finally(() => schedule(warmNext))
  }
  schedule(warmNext)
}

function currentMainAndRoot(): { main: HTMLElement; root: HTMLElement; view: string } | null {
  const main = document.getElementById("tv-main")
  if (!main) return null
  const view = main.dataset.tvView || ""
  const root = main.querySelector<HTMLElement>("[data-tv-view-root]") || main
  return { main, root, view }
}

/** Synchronous cache-first paint, run from astro:after-swap while the browser still holds the transition open. */
function prepaintCurrentView(): void {
  releasePendingPrepaint()
  const target = currentMainAndRoot()
  if (!target) return
  const resolvedView = resolvedViewModules.get(target.view)
  if (!resolvedView?.prepaint) return
  const painted = resolvedView.prepaint(target.root, new URL(location.href))
  if (!painted) return
  target.root.dataset.prepainted = "1"
  prepaintedViewName = target.view
}

async function mountCurrentView(): Promise<void> {
  const target = currentMainAndRoot()
  if (!target) return
  const loader = VIEW_LOADERS[target.view]
  if (!loader) return
  const mountGeneration = generation
  // Snapshot before the await: a Back press mid-import already moved location on.
  const url = new URL(location.href)
  const module = await loader()
  resolvedViewModules.set(target.view, module.default)
  if (mountGeneration !== generation) {
    releasePendingPrepaint()
    return
  }
  prepaintedViewName = null
  currentTeardown = module.default.mount(target.root, { view: target.view, url })
  delete target.root.dataset.prepainted
  document.dispatchEvent(new CustomEvent(TV_VIEW_MOUNTED_EVENT, { detail: { view: target.view, path: url.pathname } }))
  warmViewModules()
}

function preloadViewForHref(href: string): void {
  let pathname: string
  try {
    pathname = new URL(href, location.href).pathname
  } catch {
    return
  }
  const view = PATH_TO_VIEW[pathname.replace(/\/+$/, "") || "/tv"]
  const loader = view && VIEW_LOADERS[view]
  if (!loader || resolvedViewModules.has(view)) return
  loader()
    .then((module) => resolvedViewModules.set(view, module.default))
    .catch(() => {})
}

function onLinkFocusIn(event: FocusEvent): void {
  const target = event.target
  const link = target instanceof HTMLElement ? target.closest<HTMLAnchorElement>('a[href^="/tv"]') : null
  if (link) preloadViewForHref(link.href)
}

export function mountTvRouter(): void {
  document.addEventListener("focusin", onLinkFocusIn)
  // Brackets the whole Astro navigation transition so a view's own prepaint/setEntries
  // never starts a second, nested document.startViewTransition while Astro's is in flight.
  document.addEventListener("astro:before-preparation", beginNavigationTransition)
  document.addEventListener("astro:before-swap", teardownCurrentView)
  document.addEventListener("astro:after-swap", prepaintCurrentView)
  document.addEventListener("astro:page-load", () => {
    void mountCurrentView()
    requestAnimationFrame(endNavigationTransition)
  })
  // A no-op today (no module is resolved yet on a cold boot) but keeps the hard-load
  // path consistent should a future bfcache-like restore ever warm modules first.
  prepaintCurrentView()
}
