// Pure grouping + search model behind the cast remote's channel panel. Mirrors what
// /livetv shows: same category visibility rules, same category order, same channel sort,
// plus synthetic Favorites and All channels groups on top.
import { normalize, scoreNormMatch } from "@/scripts/lib/text.js"
import {
  sortCategoryNames,
  sortChannelsForView,
  type CategorySortMode,
  type ChannelSortMode,
} from "@/scripts/lib/channel-sort.ts"

export const GROUP_FAVORITES = "__favorites__"
export const GROUP_ALL = "__all__"

export interface CastChannel {
  id: number
  name: string
  category?: string | null
  /** Every group the channel belongs to (semicolon-split `group-title`); falls back to `category`. */
  categories?: string[] | null
  logo?: string | null
  tvgId?: string | null
  chno?: number | null
  /** Pre-normalized name from the catalog; recomputed when absent. */
  norm?: string
}

export interface CastChannelGroup {
  key: string
  label: string
  channels: CastChannel[]
}

export interface BuildCastChannelGroupsOptions {
  favorites?: Set<number> | null
  hiddenCategories?: Set<string> | null
  allowedCategories?: Set<string> | null
  categoryMode?: "hide" | "select"
  categorySort?: CategorySortMode | string
  channelSort?: ChannelSortMode | string
  uncategorizedLabel: string
  favoritesLabel: string
  allLabel: string
}

/** Every group a channel belongs to, with the uncategorized fallback applied. */
export function channelCategories(channel: CastChannel, uncategorizedLabel: string): string[] {
  const raw =
    Array.isArray(channel.categories) && channel.categories.length
      ? channel.categories
      : [channel.category || ""]
  const cleaned = raw.map((entry) => (entry || "").trim()).filter((entry, index, list) => list.indexOf(entry) === index)
  return cleaned.map((entry) => entry || uncategorizedLabel)
}

/** Same hide / select semantics the category picker applies on the Live TV page. */
function categoryPasses(name: string, options: BuildCastChannelGroupsOptions): boolean {
  if (options.categoryMode === "select") {
    const allowed = options.allowedCategories
    if (!allowed || allowed.size === 0) return true
    return allowed.has(name)
  }
  return !options.hiddenCategories?.has(name)
}

/**
 * Groups a live catalog for the panel: Favorites (only when non-empty), All channels, then one
 * group per visible category in the user's category order. Channels hidden by the category filter
 * never appear, not even under All channels.
 */
export function buildCastChannelGroups(
  channels: CastChannel[],
  options: BuildCastChannelGroupsOptions
): CastChannelGroup[] {
  const byCategory = new Map<string, CastChannel[]>()
  const visible: CastChannel[] = []
  const favorites: CastChannel[] = []

  for (const channel of channels) {
    const categories = channelCategories(channel, options.uncategorizedLabel).filter((name) =>
      categoryPasses(name, options)
    )
    if (!categories.length) continue
    visible.push(channel)
    if (options.favorites?.has(channel.id)) favorites.push(channel)
    for (const name of categories) {
      const bucket = byCategory.get(name)
      if (bucket) bucket.push(channel)
      else byCategory.set(name, [channel])
    }
  }

  const sortChannels = (list: CastChannel[]) => sortChannelsForView(list, options.channelSort || "default")
  const groups: CastChannelGroup[] = []
  if (favorites.length) {
    groups.push({ key: GROUP_FAVORITES, label: options.favoritesLabel, channels: sortChannels(favorites) })
  }
  if (visible.length) {
    groups.push({ key: GROUP_ALL, label: options.allLabel, channels: sortChannels(visible) })
  }
  for (const name of sortCategoryNames([...byCategory.keys()], options.categorySort || "default")) {
    groups.push({ key: name, label: name, channels: sortChannels(byCategory.get(name) || []) })
  }
  return groups
}

/**
 * Relevance search across a whole catalog, matching the Live TV page: name tokens score by
 * position, and an exact channel-number or id hit outranks any name match.
 */
export function searchCastChannels(channels: CastChannel[], query: string): CastChannel[] {
  const tokens = normalize(query).split(" ").filter(Boolean)
  if (!tokens.length) return []
  const numericQuery = /^\d+$/.test(query.trim()) ? query.trim() : ""
  const scored: Array<{ channel: CastChannel; score: number }> = []

  for (const channel of channels) {
    let score = scoreNormMatch(channel.norm || normalize(channel.name), tokens)
    if (numericQuery) {
      const idText = String(channel.id)
      const chnoText = channel.chno != null ? String(channel.chno) : ""
      if (idText === numericQuery || chnoText === numericQuery) score = Math.max(score, 1000)
      else if (idText.startsWith(numericQuery) || (chnoText && chnoText.startsWith(numericQuery))) {
        score = Math.max(score, 500)
      }
    }
    if (score > 0) scored.push({ channel, score })
  }

  return scored.sort((first, second) => second.score - first.score).map((entry) => entry.channel)
}
