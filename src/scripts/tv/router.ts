// Mounts the per-route view module into #tv-main's [data-tv-view-root] on every astro:page-load, tearing the previous one down on astro:before-swap.

import { releaseCachedImages } from "@/scripts/lib/img-cache.ts"

export const TV_VIEW_MOUNTED_EVENT = "xt:tv-view-mounted"

export interface TvViewContext {
  view: string
  url: URL
}

export interface TvView {
  mount(root: HTMLElement, ctx: TvViewContext): () => void
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

let currentTeardown: (() => void) | null = null
let generation = 0

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

function teardownCurrentView(): void {
  const main = document.getElementById("tv-main")
  if (currentTeardown) {
    try {
      currentTeardown()
    } catch {}
    currentTeardown = null
  }
  // The outgoing view's images stay observed otherwise, pinning its whole detached DOM.
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
      .catch(() => {})
      .finally(() => schedule(warmNext))
  }
  schedule(warmNext)
}

async function mountCurrentView(): Promise<void> {
  const main = document.getElementById("tv-main")
  if (!main) return
  const view = main.dataset.tvView || ""
  const loader = VIEW_LOADERS[view]
  if (!loader) return
  const root = main.querySelector<HTMLElement>("[data-tv-view-root]") || main
  const mountGeneration = generation
  const module = await loader()
  if (mountGeneration !== generation) return
  currentTeardown = module.default.mount(root, { view, url: new URL(location.href) })
  document.dispatchEvent(new CustomEvent(TV_VIEW_MOUNTED_EVENT, { detail: { view } }))
  warmViewModules()
}

export function mountTvRouter(): void {
  document.addEventListener("astro:before-swap", teardownCurrentView)
  document.addEventListener("astro:page-load", () => {
    void mountCurrentView()
  })
}
