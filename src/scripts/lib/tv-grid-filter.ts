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

/**
 * Same pipeline as `filterAndSortEntries`, returned as original-array indexes so callers (worker,
 * main thread) can share it without copying entry objects. Works on index numbers throughout: a
 * 180k-row catalog would otherwise allocate a wrapper object per row on every keystroke.
 */
export function filterAndSortIndexes<T extends GridFilterEntry>(
  entries: T[],
  state: GridFilterState,
  ctx: GridFilterContext<T>
): Uint32Array {
  const queryNorm = ctx.normalize(state.query || "")
  const tokens = queryNorm.length ? queryNorm.split(" ").filter(Boolean) : []
  const isSorted = state.sort === "added" || state.sort === "rating" || state.sort === "az"

  if (!state.category && !state.hideWatched && !tokens.length && !isSorted) {
    const identity = new Uint32Array(entries.length)
    for (let index = 0; index < entries.length; index++) identity[index] = index
    return identity
  }

  const candidates: number[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (state.category && !ctx.categoryMatcher(entry, state.category)) continue
    if (state.hideWatched && ctx.isWatched(entry)) continue
    candidates.push(index)
  }

  let scoreByIndex: Map<number, number> | null = null
  if (tokens.length) {
    scoreByIndex = new Map()
    let kept = 0
    for (const index of candidates) {
      const score = scoreMatch(entries[index].norm || "", tokens)
      if (score <= 0) continue
      scoreByIndex.set(index, score)
      candidates[kept++] = index
    }
    candidates.length = kept
  }

  if (state.sort === "added") {
    candidates.sort((first, second) => (entries[second].added || 0) - (entries[first].added || 0))
  } else if (state.sort === "rating") {
    candidates.sort((first, second) => {
      const delta = ratingSortValue(entries[second].rating) - ratingSortValue(entries[first].rating)
      if (delta !== 0) return delta
      return (entries[first].name || "").localeCompare(entries[second].name || "", "en", { sensitivity: "base" })
    })
  } else if (state.sort === "az") {
    candidates.sort((first, second) =>
      (entries[first].name || "").localeCompare(entries[second].name || "", "en", { sensitivity: "base" })
    )
  } else if (scoreByIndex) {
    const scores = scoreByIndex
    candidates.sort((first, second) => (scores.get(second) || 0) - (scores.get(first) || 0))
  }

  return Uint32Array.from(candidates)
}

export function filterAndSortEntries<T extends GridFilterEntry>(
  entries: T[],
  state: GridFilterState,
  ctx: GridFilterContext<T>
): T[] {
  const indexes = filterAndSortIndexes(entries, state, ctx)
  const out: T[] = new Array(indexes.length)
  for (let i = 0; i < indexes.length; i++) out[i] = entries[indexes[i]]
  return out
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
