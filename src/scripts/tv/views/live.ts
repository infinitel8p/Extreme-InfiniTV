// Live TV: groups | channels | programme guide, three spatial-nav columns.
import type { TvView, TvViewContext } from "@/scripts/tv/router"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n"
import { registerFocusSection, keepFocusedInView, refreshKeepInView, remPx } from "@/scripts/tv/focus"
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
import { buildCastChannelGroups, searchCastChannels, type CastChannelGroup } from "@/scripts/lib/tv-cast-channel-list"
import { getProgrammesSync, loadProgrammes, effectiveTvgId, EPG_LOADED_EVENT, EPG_OFFSET_EVENT } from "@/scripts/lib/epg-data.js"
import { computeNowNext, programmesForDay, type Programme } from "@/scripts/lib/now-next"
import { openProgrammeDialog } from "@/scripts/lib/programme-dialog.js"
import { debounce } from "@/scripts/lib/debounce"
import { ICON_SEARCH } from "@/scripts/lib/icons.js"
import { playLive, playCatchup } from "@/scripts/tv/playback"
import { attachLongPress, type LongPressHandle } from "@/scripts/tv/long-press.ts"
import { createActionSheet, type ActionSheetHandle } from "@/scripts/tv/ui/action-sheet.ts"
import {
  type LiveChannel,
  type GuideStatus,
  buildGroupButton,
  buildChannelRowSkeleton,
  buildChannelRow,
  buildGuideHero,
  buildUpNextHeading,
  buildGuideRowSkeleton,
  buildGuideRow,
} from "@/scripts/tv/ui/live-row"

const RENDER_CHUNK = 40
// Rows past this are dropped from the DOM as the D-pad walks on; a 10k-channel group
// would otherwise end up fully mounted (~25 nodes plus 2 logo <img> per row).
const MAX_RENDERED_ROWS = 160
const SEARCH_DEBOUNCE_MS = 140
const GUIDE_DEBOUNCE_MS = 120
const TICK_INTERVAL_MS = 60_000
const SKELETON_ROW_COUNT = 8
const LAST_CHANNEL_KEY = "xt_tv_last_channel"
const GROUPS_KEEP_IN_VIEW_REM = 7.5
const GUIDE_KEEP_IN_VIEW_REM = 8.75
const LONG_PRESS_HOLD_MS = 650
const FAVORITES_CHANGED_EVENT = "xt:favorites-changed"
// Below this the "next" title column would crowd out the channel name; live-row.ts owns the CSS toggle.
const NEXT_TITLE_MIN_COLUMN_REM = 26

interface ViewState {
  playlistId: string
  channels: LiveChannel[]
  channelById: Map<string, LiveChannel>
  groups: CastChannelGroup[]
  activeGroupKey: string
  displayed: LiveChannel[]
  searchQuery: string
  firstRendered: number
  rendered: number
  playingChannelId: string | null
  guideChannel: LiveChannel | null
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
          <div data-role="channels-track" class="flex flex-col gap-2"></div>
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
      firstRendered: 0,
      rendered: 0,
      playingChannelId: null,
      guideChannel: null,
      destroyed: false,
    }

    const unsubs: Array<() => void> = []
    let refs: Refs | null = null
    let observer: IntersectionObserver | null = null
    let tickTimer: ReturnType<typeof setInterval> | null = null
    const actionSheet: ActionSheetHandle = createActionSheet("tv-live-channel-actions-dialog")
    let longPress: LongPressHandle | null = null

    try {
      state.playingChannelId = sessionStorage.getItem(LAST_CHANNEL_KEY)
    } catch {}

    function startOfToday(): number {
      const date = new Date()
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    }

    function paintChannelRow(row: HTMLElement, channel: LiveChannel, programmes: Map<string, Programme[]> | null): void {
      const nowLine = row.querySelector<HTMLElement>('[data-role="now"]')
      const nextLine = row.querySelector<HTMLElement>('[data-role="next"]')
      const progressFill = row.querySelector<HTMLElement>('[data-role="progress"]')
      const { current, next } = computeNowNext(programmes, channel, state.playlistId)
      if (nowLine) nowLine.textContent = current?.title || ""
      if (nextLine) nextLine.textContent = next?.title || ""
      if (progressFill) progressFill.style.width = current ? `${current.progress * 100}%` : "0%"
    }

    function buildRowsFragment(start: number, end: number): DocumentFragment {
      const programmes = getProgrammesSync(state.playlistId)?.programmes ?? null
      const fragment = document.createDocumentFragment()
      for (let index = start; index < end; index++) {
        const channel = state.displayed[index]
        const row = buildChannelRow(channel, index, String(channel.id) === state.playingChannelId, channelFavorite(channel))
        paintChannelRow(row, channel, programmes)
        fragment.appendChild(row)
      }
      return fragment
    }

    function dropRow(row: HTMLElement): void {
      releaseCachedImages(row)
      row.remove()
    }

    function trimRenderedRows(from: "head" | "tail"): void {
      if (!refs) return
      let excess = state.rendered - state.firstRendered - MAX_RENDERED_ROWS
      if (excess <= 0) return
      const rows = Array.from(refs.channelsTrack.querySelectorAll<HTMLElement>("[data-channel-id]"))
      const ordered = from === "head" ? rows : rows.reverse()
      for (const row of ordered) {
        if (excess <= 0 || row.contains(document.activeElement)) break
        dropRow(row)
        excess--
        if (from === "head") state.firstRendered++
        else state.rendered--
      }
      refreshKeepInView(refs.channelsScroller)
    }

    function observeSentinel(): void {
      observer?.disconnect()
      if (!refs || state.rendered >= state.displayed.length) return
      const sentinel = refs.channelsTrack.querySelector('[data-role="channels-sentinel"]')
      if (sentinel) observer?.observe(sentinel)
    }

    function renderChannelChunk(): void {
      if (!refs) return
      const items = state.displayed
      if (state.rendered >= items.length) return
      const end = Math.min(state.rendered + RENDER_CHUNK, items.length)
      const fragment = buildRowsFragment(state.rendered, end)
      state.rendered = end
      const sentinel = refs.channelsTrack.querySelector('[data-role="channels-sentinel"]')
      if (sentinel) refs.channelsTrack.insertBefore(fragment, sentinel)
      else refs.channelsTrack.appendChild(fragment)
      if (state.rendered >= items.length) sentinel?.remove()
      trimRenderedRows("head")
      observeSentinel()
    }

    function renderPreviousChunk(): void {
      if (!refs || state.firstRendered <= 0) return
      const start = Math.max(0, state.firstRendered - RENDER_CHUNK)
      const fragment = buildRowsFragment(start, state.firstRendered)
      state.firstRendered = start
      refs.channelsTrack.insertBefore(fragment, refs.channelsTrack.firstChild)
      trimRenderedRows("tail")
      refreshKeepInView(refs.channelsScroller)
      window.SpatialNavigation?.makeFocusable?.()
    }

    function renderChannelList(items: LiveChannel[], startIndex = 0): void {
      if (!refs) return
      state.displayed = items
      const target = Math.max(0, Math.min(startIndex, Math.max(0, items.length - 1)))
      state.firstRendered = Math.max(0, target - Math.floor(MAX_RENDERED_ROWS / 2))
      state.rendered = state.firstRendered
      const sentinel = document.createElement("div")
      sentinel.dataset.role = "channels-sentinel"
      sentinel.className = "h-4"
      releaseCachedImages(refs.channelsTrack)
      refs.channelsTrack.replaceChildren(sentinel)
      do {
        renderChannelChunk()
      } while (state.rendered <= target && state.rendered < items.length)
      refs.channelsScroller.scrollTop = 0
      refs.channelsStatus.classList.toggle("hidden", items.length > 0)
      refs.channelsStatus.textContent = items.length
        ? ""
        : state.searchQuery
          ? t("livetv.noChannels")
          : t("cast.remote.channelsEmpty")
    }

    function renderGroups(): void {
      if (!refs) return
      refs.groupsTrack.replaceChildren()
      const fragment = document.createDocumentFragment()
      for (const group of state.groups) {
        fragment.appendChild(buildGroupButton(group, group.key === state.activeGroupKey))
      }
      refs.groupsTrack.appendChild(fragment)
    }

    function selectGroup(key: string, options: { focus?: boolean } = {}): void {
      if (!refs) return
      const group = state.groups.find((candidate) => candidate.key === key)
      if (!group) return
      state.activeGroupKey = key
      state.searchQuery = ""
      refs.search.value = ""
      for (const button of refs.groupsTrack.querySelectorAll<HTMLElement>("[data-group-key]")) {
        button.dataset.active = button.dataset.groupKey === key ? "true" : "false"
      }
      renderChannelList(group.channels)
      if (options.focus) refs.channelsTrack.querySelector<HTMLElement>("[data-channel-id]")?.focus()
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

    function renderGuide(channel: LiveChannel | null): void {
      if (!refs) return
      state.guideChannel = channel
      releaseCachedImages(refs.guideTrack)
      refs.guideTrack.replaceChildren()
      if (!channel) return

      const epgState = getProgrammesSync(state.playlistId)
      const tvgId = epgState ? effectiveTvgId(channel, state.playlistId) : null
      const dayProgrammes = epgState && tvgId ? epgState.programmes.get(tvgId) : undefined
      const rows = programmesForDay(dayProgrammes, startOfToday())
      const nowMs = Date.now()
      const nowNext = epgState ? computeNowNext(epgState.programmes, channel, state.playlistId, nowMs) : { current: null, next: null }
      const currentFull = nowNext.current
        ? (rows.find((row) => row.start === nowNext.current!.start && row.stop === nowNext.current!.stop) ?? null)
        : null

      const status: GuideStatus = !epgState ? "loading" : rows.length ? "ready" : "empty"
      refs.guideTrack.appendChild(
        buildGuideHero(channel, status, currentFull, nowNext.current?.progress ?? 0, channelFavorite(channel), () =>
          toggleChannelFavorite(channel)
        )
      )

      if (status === "loading") {
        const skeletons = document.createDocumentFragment()
        for (let i = 0; i < 3; i++) skeletons.appendChild(buildGuideRowSkeleton())
        refs.guideTrack.appendChild(skeletons)
        return // EPG_LOADED_EVENT repaints once the background load lands
      }

      const upcoming = currentFull ? rows.filter((row) => row !== currentFull) : rows
      if (!upcoming.length) return

      refs.guideTrack.appendChild(buildUpNextHeading())
      const fragment = document.createDocumentFragment()
      for (const programme of upcoming) fragment.appendChild(buildGuideRow(channel, programme, nowMs, onGuideReplay, onGuideDetails))
      refs.guideTrack.appendChild(fragment)
    }

    const scheduleGuideUpdate = debounce((channelId: string) => {
      const channel = state.channelById.get(channelId)
      if (channel) renderGuide(channel)
    }, GUIDE_DEBOUNCE_MS)

    function setPlayingChannel(channelId: string, _channelName?: string): void {
      state.playingChannelId = channelId
      try {
        sessionStorage.setItem(LAST_CHANNEL_KEY, channelId)
      } catch {}
      if (!refs) return
      for (const row of refs.channelsTrack.querySelectorAll<HTMLElement>("[data-channel-id]")) {
        if (row.dataset.channelId === channelId) row.dataset.nowPlaying = "true"
        else delete row.dataset.nowPlaying
      }
    }

    function activateChannel(channel: LiveChannel): void {
      void playLive(
        { playlistId: state.playlistId, channel, siblings: state.displayed },
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
      if (!refs) return
      const row = refs.channelsTrack.querySelector<HTMLElement>(`[data-channel-id="${CSS.escape(channelId)}"]`)
      row?.querySelector<HTMLElement>('[data-role="fav"]')?.classList.toggle("hidden", !favorite)
      if (state.guideChannel && String(state.guideChannel.id) === channelId) {
        renderGuide(state.guideChannel)
        refs.guideTrack.querySelector<HTMLElement>(`[data-focus-key="guide-fav:${channelId}"]`)?.focus()
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
      renderChannelList(searchCastChannels(state.channels, query))
    }, SEARCH_DEBOUNCE_MS)

    function onGroupsClick(event: Event): void {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-group-key]")
      if (target?.dataset.groupKey) selectGroup(target.dataset.groupKey, { focus: true })
    }

    function onChannelsFocusIn(event: FocusEvent): void {
      if (!refs) return
      const row = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-channel-id]")
      if (!row) return
      const rows = refs.channelsTrack.querySelectorAll("[data-channel-id]")
      if (rows[rows.length - 1] === row) renderChannelChunk()
      else if (rows[0] === row) renderPreviousChunk()
      if (row.dataset.channelId) scheduleGuideUpdate(row.dataset.channelId)
    }

    function focusChannelRow(channelId: string): void {
      if (!refs) return
      let row = refs.channelsTrack.querySelector<HTMLElement>(`[data-channel-id="${CSS.escape(channelId)}"]`)
      if (!row) {
        const index = state.displayed.findIndex((candidate) => String(candidate.id) === channelId)
        if (index < 0) return
        renderChannelList(state.displayed, index)
        row = refs.channelsTrack.querySelector<HTMLElement>(`[data-channel-id="${CSS.escape(channelId)}"]`)
      }
      row?.focus()
    }

    function tick(): void {
      if (state.destroyed || !refs) return
      const programmes = getProgrammesSync(state.playlistId)?.programmes ?? null
      for (const row of refs.channelsTrack.querySelectorAll<HTMLElement>("[data-channel-id]")) {
        const channel = row.dataset.channelId ? state.channelById.get(row.dataset.channelId) : null
        if (channel) paintChannelRow(row, channel, programmes)
      }
      if (state.guideChannel) renderGuide(state.guideChannel)
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
      if (getProgrammesSync(state.playlistId)) return
      const creds = await resolvePlaylistCreds(state.playlistId)
      if (!creds || state.destroyed) return
      await loadProgrammes(state.playlistId, creds)
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
          Math.round((refs!.channelsScroller.clientHeight || window.innerHeight) * 0.35)
        )
      )
      unsubs.push(keepFocusedInView(refs.guideScroller, "y", () => remPx(GUIDE_KEEP_IN_VIEW_REM)))

      if (typeof ResizeObserver === "function") {
        const channelsResizeObserver = new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect.width ?? 0
          refs!.channelsCol.dataset.liveWide = width >= remPx(NEXT_TITLE_MIN_COLUMN_REM) ? "true" : "false"
        })
        channelsResizeObserver.observe(refs.channelsCol)
        unsubs.push(() => channelsResizeObserver.disconnect())
      }

      if (typeof IntersectionObserver !== "undefined") {
        observer = new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) renderChannelChunk()
          },
          { root: refs.channelsScroller, rootMargin: "200px" }
        )
      }

      refs.groupsTrack.addEventListener("click", onGroupsClick)
      longPress = attachLongPress<LiveChannel>({
        container: refs.channelsTrack,
        targetSelector: "[data-channel-id]",
        resolveTarget: (row) => (row.dataset.channelId ? (state.channelById.get(row.dataset.channelId) ?? null) : null),
        onActivate: activateChannel,
        onLongPress: openChannelActionSheet,
        holdMs: LONG_PRESS_HOLD_MS,
      })
      refs.channelsScroller.addEventListener("focusin", onChannelsFocusIn)
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
      document.addEventListener(LOCALE_EVENT, applyLocale)
      document.addEventListener(FAVORITES_CHANGED_EVENT, onFavoritesChangedEvent)
      tickTimer = setInterval(tick, TICK_INTERVAL_MS)
    }

    function onEpgLoaded(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (detail?.playlistId && detail.playlistId !== state.playlistId) return
      tick()
    }

    function onEpgOffsetChanged(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (!detail || detail.playlistId !== state.playlistId) return
      void resolvePlaylistCreds(state.playlistId).then((creds) => {
        if (!creds || state.destroyed) return
        return loadProgrammes(state.playlistId, creds, { force: true })
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
      renderShell()

      const channels = await loadChannels(state.playlistId)
      if (state.destroyed) return
      state.channels = channels
      state.channelById = new Map(channels.map((channel) => [String(channel.id), channel]))

      if (!channels.length) {
        renderCentered(t("cast.remote.channelsEmpty"))
        return
      }

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
      else refs.channelsTrack.querySelector<HTMLElement>("[data-channel-id]")?.focus()

      void ensureEpgInBackground()
    }

    void boot()

    return () => {
      state.destroyed = true
      if (tickTimer) clearInterval(tickTimer)
      longPress?.destroy()
      observer?.disconnect()
      document.removeEventListener(EPG_LOADED_EVENT, onEpgLoaded)
      document.removeEventListener(EPG_OFFSET_EVENT, onEpgOffsetChanged)
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
