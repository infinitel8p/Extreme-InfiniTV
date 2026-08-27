// Pure filter/sort pipeline + row-window math for the TV movies/series grid.

export interface GridFilterState {
  category: string | null
  query: string
  hideWatched: boolean
  sort: string
}

export interface GridFilterEntry {
  id: number | string
  name?: string | null
  norm?: string
  added?: number
  rating?: unknown
  year?: string | number | null
}

export interface GridFilterContext<T> {
  categoryMatcher(entry: T, category: string): boolean
  isWatched(entry: T): boolean
  normalize(text: string): string
}

function ratingSortValue(raw: unknown): number {
  if (raw == null || raw === "") return 0
  const value = parseFloat(String(raw).trim())
  return Number.isFinite(value) && value > 0 ? value : 0
}

function scoreMatch(norm: string, tokens: string[]): number {
  if (!norm || !tokens.length) return 0
  let score = 0
  for (const token of tokens) {
    const index = norm.indexOf(token)
    if (index === -1) return 0
    score += 100 - Math.min(index, 99) + (norm.startsWith(token) ? 25 : 0)
  }
  return score
}

export function filterAndSortEntries<T extends GridFilterEntry>(
  entries: T[],
  state: GridFilterState,
  ctx: GridFilterContext<T>
): T[] {
  let out = state.category
    ? entries.filter((entry) => ctx.categoryMatcher(entry, state.category as string))
    : entries.slice()

  if (state.hideWatched) out = out.filter((entry) => !ctx.isWatched(entry))

  const queryNorm = ctx.normalize(state.query || "")
  const tokens = queryNorm.length ? queryNorm.split(" ").filter(Boolean) : []
  let scoreById: Map<T["id"], number> | null = null
  if (tokens.length) {
    scoreById = new Map()
    const scored: T[] = []
    for (const entry of out) {
      const score = scoreMatch(entry.norm || "", tokens)
      if (score > 0) {
        scored.push(entry)
        scoreById.set(entry.id, score)
      }
    }
    out = scored
  }

  const sorted = out.slice()
  if (state.sort === "added") {
    sorted.sort((first, second) => (second.added || 0) - (first.added || 0))
  } else if (state.sort === "rating") {
    sorted.sort((first, second) => {
      const delta = ratingSortValue(second.rating) - ratingSortValue(first.rating)
      if (delta !== 0) return delta
      return (first.name || "").localeCompare(second.name || "", "en", { sensitivity: "base" })
    })
  } else if (state.sort === "az") {
    sorted.sort((first, second) => (first.name || "").localeCompare(second.name || "", "en", { sensitivity: "base" }))
  } else if (scoreById) {
    const scores = scoreById
    sorted.sort((first, second) => (scores.get(second.id) || 0) - (scores.get(first.id) || 0))
  }

  return sorted
}

/** Inclusive start, exclusive end - clamped to `[0, totalRows]`. */
export function rowWindow(
  totalRows: number,
  focusedRow: number,
  visibleRows: number,
  overscanRows: number
): { start: number; end: number } {
  if (totalRows <= 0) return { start: 0, end: 0 }
  const clampedFocusedRow = Math.min(Math.max(focusedRow, 0), totalRows - 1)
  const start = Math.max(0, clampedFocusedRow - overscanRows)
  const end = Math.min(totalRows, clampedFocusedRow + Math.max(1, visibleRows) + overscanRows)
  return { start, end }
}

export function rowOf(index: number, columns: number): number {
  return columns > 0 ? Math.floor(index / columns) : 0
}
