// Cheap same-view image warm-up hints for TV rails/hero neighbours.

import { memoryConservative } from "@/scripts/tv/motion"

const MAX_WARMED_URLS = 64
const warmedUrls = new Set<string>()

function saveDataEnabled(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  return !!connection?.saveData
}

/** Fires a plain, uncounted image load to prime the browser/HTTP cache; never re-warms the same URL twice. */
export function warmImageUrl(url: string | null | undefined): void {
  if (!url || memoryConservative() || warmedUrls.has(url) || saveDataEnabled()) return
  if (warmedUrls.size >= MAX_WARMED_URLS) {
    const oldest = warmedUrls.values().next().value
    if (oldest) warmedUrls.delete(oldest)
  }
  warmedUrls.add(url)
  const image = new Image()
  image.decoding = "async"
  image.src = url
}

/** `[data-focus-key]` siblings within `radius` positions of `focusedEl`, closest first. */
export function neighboursOf(container: ParentNode, focusedEl: HTMLElement, radius: number): HTMLElement[] {
  const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-focus-key]"))
  const centerIndex = cards.indexOf(focusedEl)
  if (centerIndex < 0) return []
  const neighbours: HTMLElement[] = []
  for (let offset = 1; offset <= radius; offset++) {
    const before = cards[centerIndex - offset]
    const after = cards[centerIndex + offset]
    if (before) neighbours.push(before)
    if (after) neighbours.push(after)
  }
  return neighbours
}
