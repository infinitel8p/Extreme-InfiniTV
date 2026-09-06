// Live TV: groups | channels | programme guide, three spatial-nav columns.
import type { TvView, TvViewContext } from "@/scripts/tv/router"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n"
import { registerFocusSection, keepFocusedInView, remPx } from "@/scripts/tv/focus"
import { releaseCachedImages } from "@/scripts/lib/img-cache.ts"
import { getActiveEntry } from "@/scripts/lib/creds.js"
import { resolvePlaylistCreds } from "@/scripts/lib/tv-cast-live.js"
import { readCachedLiveChannels } from "@/scripts/lib/live-catalog.ts"
import { ensureLive } from "@/scripts/lib/catalog.js"
import {
  ensureLoaded as ensurePreferencesLoaded,
  getFavorites,
  isFavorite,
  toggleFavorite,
  getHiddenCategories,
  getAllowedCategories,
  getCategoryMode,
  getCategorySort,
  getViewSort,
} from "@/scripts/lib/preferences.js"
import { buildCastChannelGroups, type CastChannelGroup } from "@/scripts/lib/tv-cast-channel-list"
import { searchCatalog } from "@/scripts/tv/catalog-filter-client"
import { sliceSiblingWindow, NATIVE_SIBLING_WINDOW_RADIUS } from "@/scripts/lib/channel-lite.ts"
import {
  getProgrammesSync,
  loadProgrammes,
  getProgrammesForChannel,
  effectiveTvgId,
  EPG_LOADED_EVENT,
  EPG_OFFSET_EVENT,
} from "@/scripts/lib/epg-data.js"
import { epgLoadWindow, epgLoadMode, EPG_NOW_NEXT_REFRESH_MS } from "@/scripts/tv/motion"
import { computeNowNext, programmesForDay, type Programme, type NowNextSlot } from "@/scripts/lib/now-next"
import {
  tvEpgSource,
  toXtreamCreds,
  tvShortEpgCache,
  shortEpgNowNextSlot,
  shortEpgToGuideProgrammes,
  nowNextFromProgrammes,
  TV_EPG_SOURCE_CHANGED_EVENT,
  type TvEpgSource,
} from "@/scripts/tv/epg-source"
import type { XtreamCreds, ShortEpgNowNext } from "@/scripts/lib/short-epg.ts"
import { openProgrammeDialog } from "@/scripts/lib/programme-dialog.js"
import { debounce } from "@/scripts/lib/debounce"
import { ICON_SEARCH } from "@/scripts/lib/icons.js"
import { playLive, playCatchup } from "@/scripts/tv/playback"
import { attachLongPress, type LongPressHandle } from "@/scripts/tv/long-press.ts"
import { createActionSheet, type ActionSheetHandle } from "@/scripts/tv/ui/action-sheet.ts"
import { createVirtualRows, type VirtualRowsHandle } from "@/scripts/tv/ui/virtual-rows"
import {
  type LiveChannel,
  type GuideStatus,
  buildGroupButton,
  buildChannelRowSkeleton,
  buildChannelRow,
  createGuidePanel,
  type GuidePanelHandle,
} from "@/scripts/tv/ui/live-row"

const SEARCH_DEBOUNCE_MS = 140
const SEARCH_RESULT_CAP = 500
const GUIDE_DEBOUNCE_MS = 60
const TICK_INTERVAL_MS = 60_000
const EPG_GUARD_TIMEOUT_MS = 4000
const SKELETON_ROW_COUNT = 8
const LAST_CHANNEL_KEY_PREFIX = "xt_tv_last_channel"

function lastChannelStorageKey(playlistId: string): string {
  return `${LAST_CHANNEL_KEY_PREFIX}:${playlistId}`
}
const GROUPS_KEEP_IN_VIEW_REM = 7.5
const CHANNELS_KEEP_IN_VIEW_FRACTION = 0.35
const GUIDE_KEEP_IN_VIEW_REM = 8.75
const LONG_PRESS_HOLD_MS = 650
const FAVORITES_CHANGED_EVENT = "xt:favorites-changed"
// Matches live-row.ts's min-h-[4rem] row, so the initial estimate never overshoots.
const CHANNEL_ROW_FALLBACK_HEIGHT_REM = 4
const CHANNEL_ROW_GAP_REM = 0.5
const CHANNEL_ROW_OVERSCAN = 6
// Matches buildGroupButton's min-h-[3.25rem] button and the track's gap-1.
const GROUP_ROW_FALLBACK_HEIGHT_REM = 3.25
const GROUP_ROW_GAP_REM = 0.25
// Below this the "next" title column would crowd out the channel name; live-row.ts owns the CSS toggle.
const NEXT_TITLE_MIN_COLUMN_REM = 26
const GUIDE_DAY_CACHE_MAX = 10

interface ViewState {
  playlistId: string
  channels: LiveChannel[]
  channelById: Map<string, LiveChannel>
  groups: CastChannelGroup[]
  activeGroupKey: string
  displayed: LiveChannel[]
  searchQuery: string
  playingChannelId: string | null
  guideChannel: LiveChannel | null
  epgResolved: boolean
  destroyed: boolean
}

interface Refs {
  groupsCol: HTMLElement
  groupsHeading: HTMLElement
  groupsScroller: HTMLElement
  groupsTrack: HTMLElement
  channelsCol: HTMLElement
  search: HTMLInputElement
  channelsScroller: HTMLElement
  channelsTrack: HTMLElement
  channelsStatus: HTMLElement
  guideCol: HTMLElement
  guideScroller: HTMLElement
  guideTrack: HTMLElement
}

function buildShellMarkup(): string {
  return `
    <div class="grid h-full grid-cols-[10rem_minmax(0,1fr)_14rem] gap-4">
      <nav data-role="groups-col" class="flex min-h-0 flex-col overflow-hidden">
        <p data-role="groups-heading" class="shrink-0 px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-fg-3"></p>
        <div data-role="groups-scroller" class="min-h-0 flex-1 overflow-hidden">
          <div data-role="groups-track" class="flex flex-col gap-1"></div>
        </div>
      </nav>

      <div data-role="channels-col" class="flex min-h-0 flex-col overflow-hidden pt-2 px-2">
        <div class="mb-3 flex min-h-10 shrink-0 items-center gap-2 rounded-2xl bg-surface-2 px-4 tv-focus-inset-within">
          <span class="shrink-0 text-fg-3" aria-hidden="true">${ICON_SEARCH}</span>
          <input data-role="search" type="search" autocomplete="off" spellcheck="false"
                 class="w-full rounded-2xl bg-transparent text-sm outline-none placeholder:text-fg-3" />
        </div>
        <div data-role="channels-scroller" class="min-h-0 flex-1 overflow-hidden py-2">
          <div data-role="channels-track" class="relative flex flex-col gap-2"></div>
        </div>
        <p data-role="channels-status" class="hidden shrink-0 pt-3 text-center text-sm text-fg-3" role="status"></p>
      </div>

      <div data-role="guide-col" class="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface">
        <div data-role="guide-scroller" class="min-h-0 flex-1 overflow-hidden">
          <div data-role="guide-track" class="flex flex-col gap-1 p-3"></div>
        </div>
      </div>
    </div>
  `
}

function collectRefs(root: HTMLElement): Refs {
  const query = <T extends HTMLElement>(role: string) => root.querySelector<T>(`[data-role="${role}"]`)!
  return {
    groupsCol: query("groups-col"),
    groupsHeading: query("groups-heading"),
    groupsScroller: query("groups-scroller"),
    groupsTrack: query("groups-track"),
    channelsCol: query("channels-col"),
    search: query<HTMLInputElement>("search"),
    channelsScroller: query("channels-scroller"),
    channelsTrack: query("channels-track"),
    channelsStatus: query("channels-status"),
    guideCol: query("guide-col"),
    guideScroller: query("guide-scroller"),
    guideTrack: query("guide-track"),
  }
}

const view: TvView = {
  mount(root: HTMLElement, ctx: TvViewContext) {
    const state: ViewState = {
      playlistId: "",
      channels: [],
      channelById: new Map(),
      groups: [],
      activeGroupKey: "",
      displayed: [],
      searchQuery: "",
      playingChannelId: null,
      guideChannel: null,
      epgResolved: false,
      destroyed: false,
    }

    const unsubs: Array<() => void> = []
    let refs: Refs | null = null
    let channelRows: VirtualRowsHandle<LiveChannel> | null = null
    let groupRows: VirtualRowsHandle<CastChannelGroup> | null = null
    let activeGroupButtonEl: HTMLElement | null = null
    let guidePanel: GuidePanelHandle | null = null
    let tickTimer: ReturnType<typeof setInterval> | null = null
    let epgGuardTimer: ReturnType<typeof setTimeout> | null = null
    const actionSheet: ActionSheetHandle = createActionSheet("tv-live-channel-actions-dialog")
    let longPress: LongPressHandle | null = null
    // Set from keydown/keyup on the channel list scroller; a held Up/Down/PageUp/PageDown
    // suppresses the guide's dip animation and backdrop crossfade until the key is released.
    let navKeyHeld = false

    // now-next mode: today's full lineup for the guided channel is fetched on demand
    // (the shared EPG state only carries the airing + upcoming programme) and kept
    // for the last few focused channels; cleared on teardown and on periodic refresh.
    const epgMode = epgLoadMode()
    const dayProgrammesCache = new Map<string, Programme[]>()
    const fetchingDayProgrammes = new Set<string>()
    let epgRefreshTimer: ReturnType<typeof setInterval> | null = null

    // Memory-conservative TVs on an Xtream playlist read from the per-channel short-EPG
    // client instead of the bulk XMLTV feed; resolved once creds are known, in boot().
    let epgSource: TvEpgSource = "xmltv-full"
    let xtreamCreds: XtreamCreds | null = null
    const shortEpgCache = tvShortEpgCache()
    const shortEpgRowNowNext = new Map<string, ShortEpgNowNext>()

    function startOfToday(): number {
      const date = new Date()
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    }

    function paintChannelRow(row: HTMLElement, channel: LiveChannel, programmes: Map<string, Programme[]> | null): void {
      const nowLine = row.querySelector<HTMLElement>('[data-role="now"]')
      const nextLine = row.querySelector<HTMLElement>('[data-role="next"]')
      const progressFill = row.querySelector<HTMLElement>('[data-role="progress"]')
      const { current, next } =
        epgSource === "short-epg"
          ? shortEpgNowNextSlot(shortEpgRowNowNext.get(String(channel.id)) ?? null)
          : computeNowNext(programmes, channel, state.playlistId)
      if (nowLine) nowLine.textContent = current?.title || ""
      if (nextLine) nextLine.textContent = next?.title || ""
      if (progressFill) progressFill.style.transform = `scaleX(${current ? current.progress : 0})`
    }

    function requestShortEpgRowNowNext(channel: LiveChannel): void {
      if (!xtreamCreds) return
      const key = String(channel.id)
      void shortEpgCache.getNowNext(xtreamCreds, channel.id).then((nowNext) => {
        if (state.destroyed || !nowNext) return
        shortEpgRowNowNext.set(key, nowNext)
        const rowEl = channelRows?.rowForKey(key)
        if (rowEl) paintChannelRow(rowEl, channel, null)
      })
    }

    function buildAndPaintChannelRow(channel: LiveChannel, index: number): HTMLElement {
      const programmes = getProgrammesSync(state.playlistId)?.programmes ?? null
      const row = buildChannelRow(channel, index, String(channel.id) === state.playingChannelId, channelFavorite(channel))
      paintChannelRow(row, channel, programmes)
      if (epgSource === "short-epg") requestShortEpgRowNowNext(channel)
      return row
    }

    function renderChannelList(items: LiveChannel[], startIndex = 0): void {
      if (!refs) return
      state.displayed = items
      channelRows?.setItems(items, startIndex)
      refs.channelsStatus.classList.toggle("hidden", items.length > 0)
      refs.channelsStatus.textContent = items.length
        ? ""
        : state.searchQuery
          ? t("livetv.noChannels")
          : t("cast.remote.channelsEmpty")
    }

    function renderGroups(): void {
      if (!refs) return
      activeGroupButtonEl = null
      groupRows?.setItems(state.groups)
    }

    // Clears only the previously-active button (if still mounted) instead of re-scanning
    // every group row - the virtual list rebuilds any not-yet-mounted row with the right
    // state anyway, since buildGroupButton reads state.activeGroupKey live at mount time.
    function setActiveGroupButton(key: string): void {
      if (activeGroupButtonEl) activeGroupButtonEl.dataset.active = "false"
      const nextEl = groupRows?.rowForKey(key) ?? null
      if (nextEl) nextEl.dataset.active = "true"
      activeGroupButtonEl = nextEl
    }

    function selectGroup(key: string, options: { focus?: boolean } = {}): void {
      if (!refs) return
      const group = state.groups.find((candidate) => candidate.key === key)
      if (!group) return
      state.activeGroupKey = key
      state.searchQuery = ""
      refs.search.value = ""
      setActiveGroupButton(key)
      renderChannelList(group.channels)
      if (options.focus) channelRows?.focusIndex(0)
    }

    function onGuideReplay(channel: LiveChannel, programme: Programme, rawStart: number, rawStop: number): void {
      void playCatchup(
        {
          playlistId: state.playlistId,
          channel,
          startUtcMs: rawStart,
          stopUtcMs: rawStop,
          catchupId: programme.catchupId ?? null,
          title: programme.title,
          logo: channel.logo ?? null,
        },
        { onLiveChannelChanged: setPlayingChannel }
      )
    }

    function onGuideDetails(channel: LiveChannel, programme: Programme): void {
      openProgrammeDialog({
        title: programme.title,
        desc: programme.desc,
        start: programme.start,
        stop: programme.stop,
        channelName: channel.name,
        channelId: channel.id,
      })
    }

    function todayWindow(): { fromMs: number; toMs: number } {
      const fromMs = startOfToday()
      return { fromMs, toMs: fromMs + 24 * 60 * 60 * 1000 }
    }

    function rememberDayProgrammes(tvgId: string, programmes: Programme[]): void {
      dayProgrammesCache.delete(tvgId)
      dayProgrammesCache.set(tvgId, programmes)
      if (dayProgrammesCache.size > GUIDE_DAY_CACHE_MAX) {
        const oldest = dayProgrammesCache.keys().next().value
        if (oldest !== undefined) dayProgrammesCache.delete(oldest)
      }
    }

    // now-next mode's shared EPG state has no full-day array to read - fetch it per
    // channel and repaint once it lands. The result is cached (and repaints the
    // guide) even if focus moved on meanwhile, since it's cheap to keep around.
    function requestDayProgrammes(channel: LiveChannel, tvgId: string): void {
      if (fetchingDayProgrammes.has(tvgId)) return
      fetchingDayProgrammes.add(tvgId)
      void getProgrammesForChannel(state.playlistId, tvgId, todayWindow()).then((programmes) => {
        fetchingDayProgrammes.delete(tvgId)
        if (state.destroyed) return
        rememberDayProgrammes(tvgId, programmes)
        if (state.guideChannel === channel) renderGuide(channel, false)
      })
    }

    function paintGuide(channel: LiveChannel, rows: Programme[], nowNext: NowNextSlot, nowMs: number, pending: boolean, animate: boolean): void {
      const currentFull = nowNext.current
        ? (rows.find((row) => row.start === nowNext.current!.start && row.stop === nowNext.current!.stop) ?? null)
        : null
      const status: GuideStatus = rows.length ? "ready" : pending ? "loading" : "empty"
      const upcoming = currentFull ? rows.filter((row) => row !== currentFull) : rows

      guidePanel!.update({
        channel,
        status,
        current: currentFull,
        currentProgress: nowNext.current?.progress ?? 0,
        favorite: channelFavorite(channel),
        upcoming,
        nowMs,
        animate,
      })
    }

    // short-epg mode has no bulk XMLTV state at all - the day timeline and the now/next
    // slot both come from the per-channel Xtream client, cached and refetched like above.
    function requestShortEpgDayProgrammes(channel: LiveChannel, key: string): void {
      if (fetchingDayProgrammes.has(key) || !xtreamCreds) return
      fetchingDayProgrammes.add(key)
      void shortEpgCache.getProgrammes(xtreamCreds, channel.id).then((rows) => {
        fetchingDayProgrammes.delete(key)
        if (state.destroyed) return
        const mapped = rows ? programmesForDay(shortEpgToGuideProgrammes(rows), startOfToday()) : []
        rememberDayProgrammes(key, mapped)
        if (state.guideChannel === channel) renderGuide(channel, false)
      })
    }

    function renderGuide(channel: LiveChannel | null, animate = true): void {
      if (!guidePanel || !channel) return
      state.guideChannel = channel

      if (epgSource === "short-epg") {
        const key = String(channel.id)
        const cachedDay = dayProgrammesCache.get(key)
        if (!cachedDay) requestShortEpgDayProgrammes(channel, key)
        const nowMs = Date.now()
        const nowNext: NowNextSlot = cachedDay ? nowNextFromProgrammes(cachedDay, nowMs) : { current: null, next: null }
        paintGuide(channel, cachedDay ?? [], nowNext, nowMs, !cachedDay, animate)
        return
      }

      const epgState = getProgrammesSync(state.playlistId)
      const tvgId = epgState ? effectiveTvgId(channel, state.playlistId) : null
      const nowMs = Date.now()
      const nowNext: NowNextSlot = epgState
        ? computeNowNext(epgState.programmes, channel, state.playlistId, nowMs)
        : { current: null, next: null }

      if (epgMode === "now-next") {
        const cachedDay = tvgId ? dayProgrammesCache.get(tvgId) : undefined
        if (!cachedDay && tvgId) requestDayProgrammes(channel, tvgId)
        paintGuide(channel, cachedDay ?? [], nowNext, nowMs, !cachedDay, animate)
        return
      }

      const dayProgrammes = epgState && tvgId ? epgState.programmes.get(tvgId) : undefined
      const rows = programmesForDay(dayProgrammes, startOfToday())
      paintGuide(channel, rows, nowNext, nowMs, !state.epgResolved, animate)
    }

    const scheduleGuideUpdate = debounce((channelId: string) => {
      const channel = state.channelById.get(channelId)
      if (channel) renderGuide(channel)
    }, GUIDE_DEBOUNCE_MS)

    function markEpgResolved(): void {
      if (state.destroyed || state.epgResolved) return
      state.epgResolved = true
      if (epgGuardTimer) {
        clearTimeout(epgGuardTimer)
        epgGuardTimer = null
      }
      if (state.guideChannel) renderGuide(state.guideChannel, false)
    }

    function setPlayingChannel(channelId: string, _channelName?: string): void {
      state.playingChannelId = channelId
      try {
        sessionStorage.setItem(lastChannelStorageKey(state.playlistId), channelId)
      } catch {}
      channelRows?.forEachMountedRow((rowEl) => {
        if (rowEl.dataset.channelKey === channelId) rowEl.dataset.nowPlaying = "true"
        else delete rowEl.dataset.nowPlaying
      })
    }

    function activateChannel(channel: LiveChannel): void {
      const currentIndex = state.displayed.findIndex((candidate) => String(candidate.id) === String(channel.id))
      // state.displayed may have been replaced (e.g. by a search) between the long-press
      // and the action sheet's Play - fall back to the tuned channel plus the leading
      // window so it's always present, at index 0.
      const siblings =
        currentIndex < 0
          ? [channel, ...sliceSiblingWindow(state.displayed, currentIndex, NATIVE_SIBLING_WINDOW_RADIUS)]
          : sliceSiblingWindow(state.displayed, currentIndex, NATIVE_SIBLING_WINDOW_RADIUS)
      void playLive(
        { playlistId: state.playlistId, channel, siblings, groupKey: state.activeGroupKey },
        { onLiveChannelChanged: setPlayingChannel }
      )
    }

    function channelFavorite(channel: LiveChannel): boolean {
      return state.playlistId ? isFavorite(state.playlistId, "live", channel.id) : false
    }

    function toggleChannelFavorite(channel: LiveChannel): void {
      if (!state.playlistId) return
      toggleFavorite(state.playlistId, "live", channel.id, {
        name: channel.name || "",
        logo: channel.logo || null,
      })
    }

    function applyFavoriteChange(channelId: string, favorite: boolean): void {
      const row = channelRows?.rowForKey(channelId) ?? null
      row?.querySelector<HTMLElement>('[data-role="fav"]')?.classList.toggle("hidden", !favorite)
      if (state.guideChannel && String(state.guideChannel.id) === channelId) {
        renderGuide(state.guideChannel, false)
      }
    }

    function onFavoritesChangedEvent(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (!detail || detail.playlistId !== state.playlistId || detail.kind !== "live") return
      applyFavoriteChange(String(detail.id), !!detail.isFav)
    }

    function openChannelActionSheet(channel: LiveChannel): void {
      const favorite = channelFavorite(channel)
      actionSheet.open(channel.name, [
        { label: t("stream.menu.play"), onSelect: () => activateChannel(channel) },
        {
          label: t(favorite ? "list.menu.favoriteRemove" : "list.menu.favoriteAdd"),
          onSelect: () => toggleChannelFavorite(channel),
        },
      ])
    }

    const runSearch = debounce((query: string) => {
      state.searchQuery = query
      if (!query) {
        const group = state.groups.find((candidate) => candidate.key === state.activeGroupKey)
        renderChannelList(group?.channels ?? [])
        return
      }
      void searchCatalog(`live:${state.playlistId}`, state.channels, query, SEARCH_RESULT_CAP).then((indexes) => {
        if (indexes === null || state.searchQuery !== query) return
        renderChannelList(Array.from(indexes, (index) => state.channels[index]))
      })
    }, SEARCH_DEBOUNCE_MS)

    function onGroupsClick(event: Event): void {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-group-key]")
      if (target?.dataset.groupKey) selectGroup(target.dataset.groupKey, { focus: true })
    }

    function onChannelsFocusIn(event: FocusEvent): void {
      const row = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-channel-key]")
      if (row?.dataset.channelKey) scheduleGuideUpdate(row.dataset.channelKey)
    }

    const CHANNEL_NAV_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown"])

    function onChannelsKeyDown(event: KeyboardEvent): void {
      if (CHANNEL_NAV_KEYS.has(event.key)) navKeyHeld = true
    }

    function onChannelsKeyUp(event: KeyboardEvent): void {
      if (CHANNEL_NAV_KEYS.has(event.key)) navKeyHeld = false
    }

    function focusChannelRow(channelId: string): void {
      if (!channelRows?.focusKey(channelId)) channelRows?.focusIndex(0)
    }

    function tick(): void {
      if (state.destroyed) return
      if (epgSource === "short-epg") {
        // The shared cache only re-fetches an entry whose TTL has actually expired.
        channelRows?.forEachMountedRow((_rowEl, channel) => requestShortEpgRowNowNext(channel))
      } else {
        const programmes = getProgrammesSync(state.playlistId)?.programmes ?? null
        channelRows?.forEachMountedRow((rowEl, channel) => paintChannelRow(rowEl, channel, programmes))
      }
      if (state.guideChannel) renderGuide(state.guideChannel, false)
    }

    function applyLocale(): void {
      if (!refs) return
      refs.groupsHeading.textContent = t("settings.categories.title")
      refs.search.placeholder = t("cast.remote.channelsSearch")
      refs.search.setAttribute("aria-label", t("cast.remote.channelsSearch"))
      if (!state.channels.length) return
      void buildGroups().then((groups) => {
        if (state.destroyed || !refs) return
        state.groups = groups
        renderGroups()
      })
    }

    async function loadChannels(playlistId: string): Promise<LiveChannel[]> {
      let list = readCachedLiveChannels(playlistId) as LiveChannel[]
      if (!list.length) {
        const creds = await resolvePlaylistCreds(playlistId)
        if (creds) list = (await ensureLive(creds, playlistId)) as LiveChannel[]
      }
      return Array.isArray(list) ? list : []
    }

    async function buildGroups(): Promise<CastChannelGroup[]> {
      await ensurePreferencesLoaded()
      return buildCastChannelGroups(state.channels, {
        favorites: getFavorites(state.playlistId, "live"),
        hiddenCategories: getHiddenCategories(state.playlistId, "live"),
        allowedCategories: getAllowedCategories(state.playlistId, "live"),
        categoryMode: getCategoryMode(state.playlistId, "live"),
        categorySort: getCategorySort(state.playlistId, "live"),
        channelSort: getViewSort(state.playlistId, "live"),
        uncategorizedLabel: t("stream.uncategorized"),
        favoritesLabel: t("cast.remote.channelsFavorites"),
        allLabel: t("cast.remote.channelsAll"),
      })
    }

    async function ensureEpgInBackground(): Promise<void> {
      if (epgSource === "short-epg") return
      if (getProgrammesSync(state.playlistId)) return
      const creds = await resolvePlaylistCreds(state.playlistId)
      if (!creds || state.destroyed) return
      await loadProgrammes(state.playlistId, creds, { window: epgLoadWindow(), epgMode })
    }

    // now-next mode bakes "now" into the parse at load time, so unlike full mode it
    // needs an active refresh to notice a programme ending - see motion.ts.
    function startEpgRefreshTimer(): void {
      if (epgRefreshTimer || epgMode !== "now-next" || epgSource === "short-epg") return
      epgRefreshTimer = setInterval(() => {
        void resolvePlaylistCreds(state.playlistId).then((creds) => {
          if (!creds || state.destroyed) return
          return loadProgrammes(state.playlistId, creds, { force: true, window: epgLoadWindow(), epgMode }).then(() => {
            if (state.destroyed) return
            dayProgrammesCache.clear()
            tick()
          })
        })
      }, EPG_NOW_NEXT_REFRESH_MS)
    }

    function renderCentered(message: string, linkHref?: string, linkLabel?: string): void {
      root.replaceChildren()
      const wrap = document.createElement("div")
      wrap.className = "flex h-full flex-col items-center justify-center gap-3 text-center"
      const text = document.createElement("p")
      text.className = "text-fg-3"
      text.textContent = message
      wrap.appendChild(text)
      if (linkHref && linkLabel) {
        const link = document.createElement("a")
        link.href = linkHref
        link.dataset.tvAutofocus = ""
        link.className = "btn"
        link.textContent = linkLabel
        wrap.appendChild(link)
      } else {
        wrap.tabIndex = 0
        wrap.dataset.tvAutofocus = ""
      }
      root.appendChild(wrap)
    }

    function renderShell(): void {
      root.innerHTML = buildShellMarkup()
      refs = collectRefs(root)
      refs.groupsCol.id = "tv-live-groups"
      refs.channelsCol.id = "tv-live-channels"
      refs.guideCol.id = "tv-live-guide"

      for (let i = 0; i < SKELETON_ROW_COUNT; i++) refs.channelsTrack.appendChild(buildChannelRowSkeleton())

      refs.groupsHeading.textContent = t("settings.categories.title")
      refs.search.placeholder = t("cast.remote.channelsSearch")
      refs.search.setAttribute("aria-label", t("cast.remote.channelsSearch"))

      unsubs.push(
        registerFocusSection("tv-live-groups", refs.groupsCol, {
          enterTo: "last-focused",
          leaveFor: { right: "@tv-live-channels" },
        })
      )
      unsubs.push(
        registerFocusSection("tv-live-channels", refs.channelsCol, {
          defaultElement: '#tv-live-channels [data-now-playing="true"]',
          leaveFor: { left: "@tv-live-groups", right: "@tv-live-guide" },
        })
      )
      unsubs.push(
        registerFocusSection("tv-live-guide", refs.guideCol, {
          restrict: "self-first",
          leaveFor: { left: "@tv-live-channels" },
        })
      )

      unsubs.push(keepFocusedInView(refs.groupsScroller, "y", () => remPx(GROUPS_KEEP_IN_VIEW_REM)))
      unsubs.push(
        keepFocusedInView(refs.channelsScroller, "y", () =>
          Math.round((refs!.channelsScroller.clientHeight || window.innerHeight) * CHANNELS_KEEP_IN_VIEW_FRACTION)
        )
      )
      unsubs.push(keepFocusedInView(refs.guideScroller, "y", () => remPx(GUIDE_KEEP_IN_VIEW_REM)))

      channelRows = createVirtualRows<LiveChannel>({
        scroller: refs.channelsScroller,
        track: refs.channelsTrack,
        fallbackRowHeightPx: remPx(CHANNEL_ROW_FALLBACK_HEIGHT_REM) + remPx(CHANNEL_ROW_GAP_REM),
        rowGapPx: remPx(CHANNEL_ROW_GAP_REM),
        overscan: CHANNEL_ROW_OVERSCAN,
        keyOf: (channel) => String(channel.id),
        buildRow: buildAndPaintChannelRow,
        onRowUnmount: releaseCachedImages,
      })

      groupRows = createVirtualRows<CastChannelGroup>({
        scroller: refs.groupsScroller,
        track: refs.groupsTrack,
        fallbackRowHeightPx: remPx(GROUP_ROW_FALLBACK_HEIGHT_REM) + remPx(GROUP_ROW_GAP_REM),
        rowGapPx: remPx(GROUP_ROW_GAP_REM),
        keyOf: (group) => group.key,
        buildRow: (group) => buildGroupButton(group, group.key === state.activeGroupKey),
      })

      guidePanel = createGuidePanel(refs.guideTrack, {
        onToggleFavorite: toggleChannelFavorite,
        onReplay: onGuideReplay,
        onDetails: onGuideDetails,
        isNavKeyHeld: () => navKeyHeld,
      })

      if (typeof ResizeObserver === "function") {
        const channelsResizeObserver = new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect.width ?? 0
          refs!.channelsCol.dataset.liveWide = width >= remPx(NEXT_TITLE_MIN_COLUMN_REM) ? "true" : "false"
        })
        channelsResizeObserver.observe(refs.channelsCol)
        unsubs.push(() => channelsResizeObserver.disconnect())
      }

      refs.groupsTrack.addEventListener("click", onGroupsClick)
      longPress = attachLongPress<LiveChannel>({
        container: refs.channelsTrack,
        targetSelector: "[data-channel-key]",
        resolveTarget: (row) => (row.dataset.channelKey ? (state.channelById.get(row.dataset.channelKey) ?? null) : null),
        onActivate: activateChannel,
        onLongPress: openChannelActionSheet,
        holdMs: LONG_PRESS_HOLD_MS,
      })
      refs.channelsScroller.addEventListener("focusin", onChannelsFocusIn)
      refs.channelsScroller.addEventListener("keydown", onChannelsKeyDown, true)
      refs.channelsScroller.addEventListener("keyup", onChannelsKeyUp, true)
      refs.search.addEventListener("input", () => runSearch(refs!.search.value.trim()))
      refs.search.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && refs!.search.value) {
          event.stopPropagation()
          refs!.search.value = ""
          runSearch("")
        }
      })

      document.addEventListener(EPG_LOADED_EVENT, onEpgLoaded)
      document.addEventListener(EPG_OFFSET_EVENT, onEpgOffsetChanged)
      document.addEventListener(TV_EPG_SOURCE_CHANGED_EVENT, onEpgSourceChanged)
      document.addEventListener(LOCALE_EVENT, applyLocale)
      document.addEventListener(FAVORITES_CHANGED_EVENT, onFavoritesChangedEvent)
      tickTimer = setInterval(tick, TICK_INTERVAL_MS)
    }

    function onEpgLoaded(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (detail?.playlistId && detail.playlistId !== state.playlistId) return
      markEpgResolved()
      tick()
    }

    // The provider's short-EPG endpoint proved empirically empty - switch to the
    // streaming XMLTV path exactly as if it had won at boot.
    function onEpgSourceChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (epgSource !== "short-epg" || !detail || detail.playlistId !== state.playlistId) return
      epgSource = detail.source
      dayProgrammesCache.clear()
      void ensureEpgInBackground()
      startEpgRefreshTimer()
    }

    function onEpgOffsetChanged(event: Event): void {
      if (epgSource === "short-epg") return
      const detail = (event as CustomEvent).detail
      if (!detail || detail.playlistId !== state.playlistId) return
      void resolvePlaylistCreds(state.playlistId).then((creds) => {
        if (!creds || state.destroyed) return
        return loadProgrammes(state.playlistId, creds, { force: true, window: epgLoadWindow(), epgMode }).then(() => {
          if (state.destroyed) return
          // Cached day arrays carry the old offset baked into start/stop - drop them.
          dayProgrammesCache.clear()
          tick()
        })
      })
    }

    async function boot(): Promise<void> {
      const activeEntry = await getActiveEntry()
      if (state.destroyed) return
      if (!activeEntry) {
        renderCentered(t("list.noPlaylistSelected"), "/tv/login", t("playlist.addCta"))
        return
      }
      state.playlistId = activeEntry._id
      try {
        state.playingChannelId = sessionStorage.getItem(lastChannelStorageKey(state.playlistId))
      } catch {}
      const creds = await resolvePlaylistCreds(state.playlistId)
      if (state.destroyed) return
      xtreamCreds = creds ? toXtreamCreds(state.playlistId, creds) : null
      epgSource = tvEpgSource(xtreamCreds)
      renderShell()

      const channels = await loadChannels(state.playlistId)
      if (state.destroyed) return
      state.channels = channels
      state.channelById = new Map(channels.map((channel) => [String(channel.id), channel]))

      if (!channels.length) {
        renderCentered(t("cast.remote.channelsEmpty"))
        return
      }

      releaseCachedImages(refs!.channelsTrack)
      refs!.channelsTrack.replaceChildren()

      state.groups = await buildGroups()
      if (state.destroyed || !refs) return
      renderGroups()

      const requestedChannelId = ctx.url.searchParams.get("channel")
      const requestedChannel = requestedChannelId ? state.channelById.get(requestedChannelId) : null
      const initialGroupKey =
        (requestedChannel &&
          state.groups.find((group) => group.channels.some((candidate) => candidate.id === requestedChannel.id))?.key) ||
        state.groups[0]?.key ||
        ""
      selectGroup(initialGroupKey)

      if (requestedChannel) focusChannelRow(String(requestedChannel.id))
      else channelRows?.focusIndex(0)

      epgGuardTimer = setTimeout(markEpgResolved, EPG_GUARD_TIMEOUT_MS)
      void ensureEpgInBackground().then(markEpgResolved)
      startEpgRefreshTimer()
    }

    void boot()

    return () => {
      state.destroyed = true
      if (tickTimer) clearInterval(tickTimer)
      if (epgGuardTimer) clearTimeout(epgGuardTimer)
      if (epgRefreshTimer) clearInterval(epgRefreshTimer)
      dayProgrammesCache.clear()
      fetchingDayProgrammes.clear()
      shortEpgRowNowNext.clear()
      longPress?.destroy()
      channelRows?.destroy()
      groupRows?.destroy()
      guidePanel?.destroy()
      document.removeEventListener(EPG_LOADED_EVENT, onEpgLoaded)
      document.removeEventListener(EPG_OFFSET_EVENT, onEpgOffsetChanged)
      document.removeEventListener(TV_EPG_SOURCE_CHANGED_EVENT, onEpgSourceChanged)
      document.removeEventListener(LOCALE_EVENT, applyLocale)
      document.removeEventListener(FAVORITES_CHANGED_EVENT, onFavoritesChangedEvent)
      for (const unsub of unsubs) unsub()
      actionSheet.destroy()
      releaseCachedImages(root)
      root.replaceChildren()
      state.channels = []
      state.channelById = new Map()
      state.groups = []
      state.displayed = []
    }
  },
}

export default view
