// Shared long-press action-sheet item builders for TV poster/live cards:
// open, favorite toggle, watchlist toggle. Mirrors poster-menu.ts's classic desktop menu.

import { navigate } from "astro:transitions/client"
import { t } from "@/scripts/lib/i18n"
import { isFavorite, toggleFavorite, isOnWatchlist, toggleWatchlist } from "@/scripts/lib/preferences.js"
import type { ActionSheetItem } from "@/scripts/tv/ui/action-sheet.ts"

export interface CatalogMenuTarget {
  kind: "vod" | "series" | "live"
  id: string | number
  name: string
  logo: string | null
  playlistId: string
  href: string
  includeWatchlist?: boolean
}

export function buildCatalogMenuActions(target: CatalogMenuTarget): ActionSheetItem[] {
  const extras = { name: target.name, logo: target.logo }
  const favorite = isFavorite(target.playlistId, target.kind, target.id)
  const actions: ActionSheetItem[] = [
    { label: t("list.menu.open"), onSelect: () => { void navigate(target.href) } },
    {
      label: t(favorite ? "list.menu.favoriteRemove" : "list.menu.favoriteAdd"),
      onSelect: () => toggleFavorite(target.playlistId, target.kind, target.id, extras),
    },
  ]
  if (target.includeWatchlist && target.kind !== "live") {
    const onWatchlist = isOnWatchlist(target.playlistId, target.kind, target.id)
    actions.push({
      label: t(onWatchlist ? "list.menu.watchlistRemove" : "list.menu.watchlistAdd"),
      onSelect: () => toggleWatchlist(target.playlistId, target.kind, target.id, extras),
    })
  }
  return actions
}
