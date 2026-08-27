// Mounts the per-route view module into #tv-main's [data-tv-view-root] on every astro:page-load, tearing the previous one down on astro:before-swap.

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

function teardownCurrentView(): void {
  if (currentTeardown) {
    try {
      currentTeardown()
    } catch {}
    currentTeardown = null
  }
  generation++
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
}

export function mountTvRouter(): void {
  document.addEventListener("astro:before-swap", teardownCurrentView)
  document.addEventListener("astro:page-load", () => {
    void mountCurrentView()
  })
}
