// The two things the cast remote's picker can browse: live channels by group, and a
// series' episodes by season. Each one adapts its own data to the generic picker shell.
import { t } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import { castLiveChannel, resolvePlaylistCreds } from "@/scripts/lib/tv-cast-live.js"
import { castSeriesEpisode, loadSeriesEpisodes } from "@/scripts/lib/tv-cast-episode.js"
import {
  buildCastChannelGroups,
  searchCastChannels,
  GROUP_ALL,
  GROUP_FAVORITES,
  type CastChannel,
} from "@/scripts/lib/tv-cast-channel-list.js"
import { ICON_LIST_DETAILS, ICON_STAR } from "@/scripts/lib/icons.js"
import type { PickerGroup, PickerItem, PickerSource } from "@/scripts/lib/tv-cast-picker-panel.js"
import type { SeriesEpisodeEntry } from "@/scripts/lib/tv-cast-next.js"

function groupIcon(key: string): string | undefined {
  if (key === GROUP_FAVORITES) return ICON_STAR
  if (key === GROUP_ALL) return ICON_LIST_DETAILS
  return undefined
}

export interface ChannelSourceOptions {
  playlistId: string
  getPlayingChannelId(): string | null
}

export function createChannelPickerSource(options: ChannelSourceOptions): PickerSource {
  let channels: CastChannel[] = []
  let programmes: Map<string, unknown[]> | null = null
  let getNowNext: ((programmes: unknown, channel: unknown, playlistId: string) => any) | null = null

  function nowProgrammeTitle(channel: CastChannel): string {
    if (!programmes || !getNowNext) return ""
    try {
      return getNowNext(programmes, channel, options.playlistId)?.current?.title || ""
    } catch {
      return ""
    }
  }

  function toItem(channel: CastChannel): PickerItem {
    return {
      id: String(channel.id),
      title: channel.name,
      subtitle: nowProgrammeTitle(channel),
      logoUrl: channel.logo || null,
      logoLookup: { name: channel.name, tvgId: channel.tvgId ?? null },
    }
  }

  /** EPG lines are a bonus: only an already-parsed feed is used, never a fresh XMLTV fetch. */
  async function attachProgrammes(): Promise<void> {
    try {
      const epg = await import("@/scripts/lib/epg-data.js")
      const state = epg.getProgrammesSync(options.playlistId)
      if (!state?.programmes) return
      programmes = state.programmes
      getNowNext = epg.getNowNextForChannel
    } catch (err) {
      log.warn("[xt:tv-cast-picker] EPG lookup unavailable:", err)
    }
  }

  return {
    labels: {
      heading: t("cast.remote.channels"),
      searchPlaceholder: t("cast.remote.channelsSearch"),
      results: t("cast.remote.pickerResults"),
      loading: t("cast.remote.channelsLoading"),
      empty: t("cast.remote.channelsEmpty"),
      noMatch: t("cast.remote.pickerNoMatch"),
      failed: t("cast.remote.channelsFailed"),
      tuneFailed: t("cast.remote.channelsTuneFailed"),
      backToGroups: t("cast.remote.backToGroups"),
    },
    async load(): Promise<PickerGroup[]> {
      const { readCachedLiveChannels } = await import("@/scripts/lib/live-catalog.ts")
      let list: CastChannel[] = readCachedLiveChannels(options.playlistId) as CastChannel[]
      if (!list.length) {
        const creds = await resolvePlaylistCreds(options.playlistId)
        if (creds) {
          const { ensureLive } = await import("@/scripts/lib/catalog.js")
          list = await ensureLive(creds, options.playlistId)
        }
      }
      channels = Array.isArray(list) ? list : []
      await attachProgrammes()

      const preferences = await import("@/scripts/lib/preferences.js")
      const groups = buildCastChannelGroups(channels, {
        favorites: preferences.getFavorites(options.playlistId, "live"),
        hiddenCategories: preferences.getHiddenCategories(options.playlistId, "live"),
        allowedCategories: preferences.getAllowedCategories(options.playlistId, "live"),
        categoryMode: preferences.getCategoryMode(options.playlistId, "live"),
        categorySort: preferences.getCategorySort(options.playlistId, "live"),
        channelSort: preferences.getViewSort(options.playlistId, "live"),
        uncategorizedLabel: t("stream.uncategorized"),
        favoritesLabel: t("cast.remote.channelsFavorites"),
        allLabel: t("cast.remote.channelsAll"),
      })
      return groups.map((group) => ({
        key: group.key,
        label: group.label,
        icon: groupIcon(group.key),
        items: group.channels.map(toItem),
      }))
    },
    search(query: string): PickerItem[] {
      return searchCastChannels(channels, query).map(toItem)
    },
    playingId: options.getPlayingChannelId,
    activate(item: PickerItem, siblingIds: string[]): Promise<boolean> {
      return castLiveChannel(options.playlistId, item.id, { groupChannelIds: siblingIds })
    },
  }
}

export interface EpisodeSourceOptions {
  playlistId: string
  seriesId: string
  /** "<season>:<episode>" of whatever the receiver is playing. */
  getPlayingEpisodeId(): string | null
}

export function episodeItemId(season: number, episodeNum: number): string {
  return `${season}:${episodeNum}`
}

export function createEpisodePickerSource(options: EpisodeSourceOptions): PickerSource {
  let episodes: SeriesEpisodeEntry[] = []

  function toItem(entry: SeriesEpisodeEntry): PickerItem {
    return {
      id: episodeItemId(entry.season, entry.episodeNum),
      title: entry.title || t("series.episode.fallback", { n: entry.episodeNum }),
      subtitle:
        t("detail.seasonShort", { n: entry.season }) + t("detail.episodeShort", { n: entry.episodeNum }),
    }
  }

  return {
    labels: {
      heading: t("detail.section.episodes"),
      searchPlaceholder: t("cast.remote.episodesSearch"),
      results: t("cast.remote.pickerResults"),
      loading: t("common.loading"),
      empty: t("cast.remote.episodesEmpty"),
      noMatch: t("cast.remote.pickerNoMatch"),
      failed: t("series.error.cantLoadEpisodes"),
      tuneFailed: t("cast.remote.episodeTuneFailed"),
      backToGroups: t("cast.remote.backToSeasons"),
    },
    async load(): Promise<PickerGroup[]> {
      episodes = await loadSeriesEpisodes(options.playlistId, options.seriesId)
      const bySeason = new Map<number, SeriesEpisodeEntry[]>()
      for (const entry of episodes) {
        const bucket = bySeason.get(entry.season)
        if (bucket) bucket.push(entry)
        else bySeason.set(entry.season, [entry])
      }
      return [...bySeason.entries()]
        .sort((first, second) => first[0] - second[0])
        .map(([season, seasonEpisodes]) => ({
          key: `s${season}`,
          label: t("series.season", { n: season }),
          items: seasonEpisodes.map(toItem),
        }))
    },
    search(query: string): PickerItem[] {
      const needle = query.toLowerCase()
      return episodes
        .filter((entry) => {
          const label = `${t("detail.seasonShort", { n: entry.season })}${t("detail.episodeShort", { n: entry.episodeNum })}`
          return (entry.title || "").toLowerCase().includes(needle) || label.toLowerCase().includes(needle)
        })
        .map(toItem)
    },
    playingId: options.getPlayingEpisodeId,
    async activate(item: PickerItem): Promise<boolean> {
      const [season, episodeNum] = item.id.split(":").map(Number)
      const entry = episodes.find((candidate) => candidate.season === season && candidate.episodeNum === episodeNum)
      return castSeriesEpisode(options.playlistId, options.seriesId, season, episodeNum, { entry })
    },
  }
}
