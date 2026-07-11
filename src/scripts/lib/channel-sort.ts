// Display-time sorting for live channel lists. "default" preserves the
// source (provider) order; during a search, relevance wins instead.

export type ChannelSortMode = "default" | "number" | "az" | "za" | "cataz"
export type CategorySortMode = "default" | "az" | "za"

export interface SortableChannel {
  id: number
  name: string
  category?: string | null
  chno?: number | null
}

function channelNumber(channel: SortableChannel): number {
  return typeof channel.chno === "number" && Number.isFinite(channel.chno)
    ? channel.chno
    : Number.POSITIVE_INFINITY
}


function textSortKey(text: string): string {
  const stripped = text.replace(/^[^\p{L}\p{N}]+/u, "")
  return stripped || text
}

function compareText(first: string, second: string): number {
  return textSortKey(first).localeCompare(textSortKey(second), "en", {
    sensitivity: "base",
    ignorePunctuation: true,
  })
}

function compareNames(first: SortableChannel, second: SortableChannel): number {
  return compareText(first.name || "", second.name || "")
}

/**
 * Sort a channel list for display. The input is never mutated.
 *
 * - `default`: source order, or relevance when `scoreById` is provided.
 * - `number`: by channel number (`tvg-chno` / Xtream `num`); channels
 *   without a number keep their source order at the end.
 * - `az` / `za`: by name.
 * - `cataz`: by category name, then by channel name within each category.
 */
export function sortChannelsForView<T extends SortableChannel>(
  list: T[],
  mode: ChannelSortMode | string,
  scoreById?: Map<number, number> | null,
): T[] {
  if (mode === "number") {
    return list.slice().sort((first, second) => {
      const firstNumber = channelNumber(first)
      const secondNumber = channelNumber(second)
      if (firstNumber === secondNumber) return 0
      return firstNumber - secondNumber
    })
  }
  if (mode === "az" || mode === "za") {
    const direction = mode === "za" ? -1 : 1
    return list
      .slice()
      .sort((first, second) => direction * compareNames(first, second))
  }
  if (mode === "cataz") {
    return list.slice().sort((first, second) => {
      const byCategory = compareText(
        first.category || "",
        second.category || "",
      )
      return byCategory !== 0 ? byCategory : compareNames(first, second)
    })
  }
  if (scoreById) {
    return list
      .slice()
      .sort(
        (first, second) =>
          (scoreById.get(second.id) || 0) - (scoreById.get(first.id) || 0),
      )
  }
  return list
}

/** Sort category / group names for display; "default" keeps source order. Never mutates the input. */
export function sortCategoryNames(
  names: string[],
  mode: CategorySortMode | string,
): string[] {
  if (mode === "az" || mode === "za") {
    const direction = mode === "za" ? -1 : 1
    return names.slice().sort((first, second) => direction * compareText(first, second))
  }
  return names.slice()
}
