// Live TV: groups | channels | programme guide, three spatial-nav columns.
import type { TvView, TvViewContext } from "@/scripts/tv/router"
import { t, getActiveLocale, LOCALE_EVENT } from "@/scripts/lib/i18n"
import { registerFocusSection, keepFocusedInView } from "@/scripts/tv/focus"
import { getActiveEntry } from "@/scripts/lib/creds.js"
import { resolvePlaylistCreds } from "@/scripts/lib/tv-cast-live.js"
import { readCachedLiveChannels } from "@/scripts/lib/live-catalog.ts"
import { ensureLive } from "@/scripts/lib/catalog.js"
import {
  ensureLoaded as ensurePreferencesLoaded,
  getFavorites,
  getHiddenCategories,
  getAllowedCategories,
  getCategoryMode,
  getCategorySort,
  getViewSort,
} from "@/scripts/lib/preferences.js"
import {
  buildCastChannelGroups,
  searchCastChannels,
  type CastChannel,
  type CastChannelGroup,
} from "@/scripts/lib/tv-cast-channel-list"
import { getProgrammesSync, loadProgrammes, effectiveTvgId, EPG_LOADED_EVENT } from "@/scripts/lib/epg-data.js"
import {
  computeNowNext,
  formatTimeRange,
  programmesForDay,
  type Programme,
  type NowNextSlot,
} from "@/scripts/lib/now-next"
import { channelSupportsCatchup, isCatchupPlayable, type CatchupCapableChannel } from "@/scripts/lib/catchup.ts"
import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { openProgrammeDialog } from "@/scripts/lib/programme-dialog.js"
import { debounce } from "@/scripts/lib/debounce"
import { ICON_SEARCH } from "@/scripts/lib/icons.js"
import { playLive, playCatchup } from "@/scripts/tv/playback"

const RENDER_CHUNK = 40
const SEARCH_DEBOUNCE_MS = 140
const GUIDE_DEBOUNCE_MS = 120
const TICK_INTERVAL_MS = 60_000
const SKELETON_ROW_COUNT = 8
const LAST_CHANNEL_KEY = "xt_tv_last_channel"
const GROUPS_KEEP_IN_VIEW_OFFSET = 120
const GUIDE_KEEP_IN_VIEW_OFFSET = 140

interface LiveChannel extends CastChannel, CatchupCapableChannel {
  tvgShift?: number | null
}

interface ViewState {
  playlistId: string
  channels: LiveChannel[]
  channelById: Map<string, LiveChannel>
  groups: CastChannelGroup[]
  activeGroupKey: string
  displayed: LiveChannel[]
  searchQuery: string
  rendered: number
  playingChannelId: string | null
  guideChannel: LiveChannel | null
  destroyed: boolean
}

interface Refs {
  groupsCol: HTMLElement
  groupsScroller: HTMLElement
  groupsTrack: HTMLElement
  channelsCol: HTMLElement
  search: HTMLInputElement
  channelsScroller: HTMLElement
  channelsTrack: HTMLElement
  channelsStatus: HTMLElement
  guideCol: HTMLElement
  guideHeader: HTMLElement
  guideScroller: HTMLElement
  guideTrack: HTMLElement
}

function buildShellMarkup(): string {
  return `
    <div class="grid h-full grid-cols-[16rem_minmax(0,1fr)_26rem] gap-6">
      <nav data-role="groups-col" class="flex min-h-0 flex-col overflow-hidden">
        <div data-role="groups-scroller" class="min-h-0 flex-1 overflow-hidden p-2">
          <div data-role="groups-track" class="flex flex-col gap-1"></div>
        </div>
      </nav>

      <div data-role="channels-col" class="flex min-h-0 flex-col overflow-hidden pt-2 px-2">
        <div class="mb-3 flex shrink-0 items-center gap-2 rounded-lg bg-surface-2 px-3">
          <span class="shrink-0 text-fg-3" aria-hidden="true">${ICON_SEARCH}</span>
          <input data-role="search" type="search" autocomplete="off" spellcheck="false"
                 class="min-h-11 w-full rounded-lg bg-transparent text-sm outline-none tv-focus-inset placeholder:text-fg-3" />
        </div>
        <div data-role="channels-scroller" class="min-h-0 flex-1 overflow-hidden py-2">
          <div data-role="channels-track" class="flex flex-col gap-1"></div>
        </div>
        <p data-role="channels-status" class="hidden shrink-0 pt-3 text-center text-sm text-fg-3" role="status"></p>
      </div>

      <div data-role="guide-col" class="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface">
        <header data-role="guide-header" class="hidden shrink-0 items-center gap-3 border-b border-line p-4"></header>
        <div data-role="guide-scroller" class="min-h-0 flex-1 overflow-hidden">
          <div data-role="guide-track" class="flex flex-col gap-1 p-2"></div>
        </div>
      </div>
    </div>
  `
}

function collectRefs(root: HTMLElement): Refs {
  const query = <T extends HTMLElement>(role: string) => root.querySelector<T>(`[data-role="${role}"]`)!
  return {
    groupsCol: query("groups-col"),
    groupsScroller: query("groups-scroller"),
    groupsTrack: query("groups-track"),
    channelsCol: query("channels-col"),
    search: query<HTMLInputElement>("search"),
    channelsScroller: query("channels-scroller"),
    channelsTrack: query("channels-track"),
    channelsStatus: query("channels-status"),
    guideCol: query("guide-col"),
    guideHeader: query("guide-header"),
    guideScroller: query("guide-scroller"),
    guideTrack: query("guide-track"),
  }
}

function buildLogoChip(logoUrl: string | null | undefined, sizeClass: string): HTMLSpanElement {
  const box = document.createElement("span")
  box.setAttribute("aria-hidden", "true")
  box.className = `grid aspect-video shrink-0 place-items-center overflow-hidden rounded-md bg-surface-2 ring-1 ring-inset ring-line ${sizeClass}`
  if (logoUrl) {
    const img = document.createElement("img")
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    img.referrerPolicy = "no-referrer"
    img.className = "h-full w-full object-contain"
    mountCachedImage(img, logoUrl, "logo")
    box.appendChild(img)
  }
  return box
}

function buildSkeletonRow(): HTMLDivElement {
  const row = document.createElement("div")
  row.setAttribute("aria-hidden", "true")
  row.className =
    "grid min-h-[4.5rem] grid-cols-[3.25rem_4rem_minmax(0,1fr)] items-center gap-3 rounded-xl px-3 py-2"
  const number = document.createElement("span")
  number.className = "h-4 w-6 animate-pulse justify-self-center rounded bg-surface-2"
  const logo = document.createElement("span")
  logo.className = "aspect-video h-10 animate-pulse rounded-md bg-surface-2"
  const text = document.createElement("span")
  text.className = "flex h-8 flex-col justify-center gap-2"
  const line1 = document.createElement("span")
  line1.className = "h-3 w-2/3 animate-pulse rounded bg-surface-2"
  const line2 = document.createElement("span")
  line2.className = "h-2.5 w-1/3 animate-pulse rounded bg-surface-2"
  text.append(line1, line2)
  row.append(number, logo, text)
  return row
}

function buildGroupButton(group: CastChannelGroup, isActive: boolean): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.dataset.focusKey = `group:${group.key}`
  button.dataset.groupKey = group.key
  button.dataset.active = isActive ? "true" : "false"
  button.className =
    "group/grp relative flex min-h-12 w-full items-center gap-3 rounded-xl px-4 text-start outline-none " +
    "transition-colors hover:bg-surface-2 tv-focus-inset data-[active=true]:bg-surface-2 data-[active=true]:text-fg"

  const accentBar = document.createElement("span")
  accentBar.setAttribute("aria-hidden", "true")
  accentBar.className =
    "absolute inset-y-2 left-0 w-1 rounded-full bg-accent opacity-0 transition-opacity group-data-[active=true]/grp:opacity-100"

  const label = document.createElement("span")
  label.className = "min-w-0 flex-1 truncate text-sm"
  label.textContent = group.label

  const count = document.createElement("span")
  count.className = "shrink-0 text-xs tabular-nums text-fg-3"
  count.textContent = group.channels.length.toLocaleString()

  button.append(accentBar, label, count)
  return button
}

function buildChannelRow(channel: LiveChannel, index: number, isPlaying: boolean): HTMLButtonElement {
  const row = document.createElement("button")
  row.type = "button"
  row.className =
    "channel-row grid min-h-[4.5rem] w-full grid-cols-[3.25rem_4rem_minmax(0,1fr)] items-center gap-3 rounded-xl px-3 py-2 " +
    "text-start outline-none hover:bg-surface-2 tv-focus-inset"
  row.dataset.focusKey = `ch:${channel.id}`
  row.dataset.channelId = String(channel.id)
  if (isPlaying) row.dataset.nowPlaying = "true"

  const number = document.createElement("span")
  number.className = "text-center text-sm tabular-nums text-fg-3"
  number.textContent = String(channel.chno ?? index + 1)
  row.appendChild(number)

  row.appendChild(buildLogoChip(channel.logo, "h-10"))

  const textCol = document.createElement("span")
  textCol.className = "flex min-w-0 items-center gap-3"

  const mainCol = document.createElement("span")
  mainCol.className = "flex min-w-0 flex-1 flex-col gap-1"
  const nameLine = document.createElement("span")
  nameLine.className = "truncate text-sm font-medium"
  nameLine.textContent = channel.name
  const nowLine = document.createElement("span")
  nowLine.dataset.role = "now"
  nowLine.className = "truncate text-xs text-fg-3"
  const progressTrack = document.createElement("span")
  progressTrack.className = "block h-[2px] w-full overflow-hidden rounded-full bg-line"
  const progressFill = document.createElement("span")
  progressFill.dataset.role = "progress"
  progressFill.className = "block h-full rounded-full bg-accent"
  progressTrack.appendChild(progressFill)
  mainCol.append(nameLine, nowLine, progressTrack)
  textCol.appendChild(mainCol)

  const nextLine = document.createElement("span")
  nextLine.dataset.role = "next"
  nextLine.className = "hidden max-w-[8rem] shrink-0 truncate text-2xs text-fg-3 sm:block"
  textCol.appendChild(nextLine)

  row.appendChild(textCol)
  return row
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
      rendered: 0,
      playingChannelId: null,
      guideChannel: null,
      destroyed: false,
    }

    const unsubs: Array<() => void> = []
    let refs: Refs | null = null
    let observer: IntersectionObserver | null = null
    let tickTimer: ReturnType<typeof setInterval> | null = null

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

    function renderChannelChunk(): void {
      if (!refs) return
      const items = state.displayed
      if (state.rendered >= items.length) return
      const programmes = getProgrammesSync(state.playlistId)?.programmes ?? null
      const fragment = document.createDocumentFragment()
      const end = Math.min(state.rendered + RENDER_CHUNK, items.length)
      for (let index = state.rendered; index < end; index++) {
        const channel = items[index]
        const row = buildChannelRow(channel, index, String(channel.id) === state.playingChannelId)
        paintChannelRow(row, channel, programmes)
        fragment.appendChild(row)
      }
      state.rendered = end
      const sentinel = refs.channelsTrack.querySelector('[data-role="channels-sentinel"]')
      if (sentinel) refs.channelsTrack.insertBefore(fragment, sentinel)
      else refs.channelsTrack.appendChild(fragment)
      if (state.rendered >= items.length) sentinel?.remove()
      observer?.disconnect()
      if (refs && state.rendered < items.length) {
        const nextSentinel = refs.channelsTrack.querySelector('[data-role="channels-sentinel"]')
        if (nextSentinel) observer?.observe(nextSentinel)
      }
    }

    function renderChannelList(items: LiveChannel[]): void {
      if (!refs) return
      state.displayed = items
      state.rendered = 0
      const sentinel = document.createElement("div")
      sentinel.dataset.role = "channels-sentinel"
      sentinel.className = "h-4"
      refs.channelsTrack.replaceChildren(sentinel)
      renderChannelChunk()
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

    function renderGuideHeader(channel: LiveChannel | null): void {
      if (!refs) return
      refs.guideHeader.replaceChildren()
      refs.guideHeader.classList.toggle("hidden", !channel)
      refs.guideHeader.classList.toggle("flex", !!channel)
      if (!channel) return
      const nameEl = document.createElement("span")
      nameEl.className = "min-w-0 flex-1 truncate text-base font-semibold"
      nameEl.textContent = channel.name
      refs.guideHeader.append(buildLogoChip(channel.logo, "h-12"), nameEl)
    }

    function buildGuideRow(channel: LiveChannel, programme: Programme, nowNext: NowNextSlot, nowMs: number): HTMLButtonElement {
      const isCurrent =
        !!nowNext.current && nowNext.current.start === programme.start && nowNext.current.stop === programme.stop
      const isPast = programme.stop <= nowMs
      // rawStart/rawStop recover true XMLTV time; catch-up must not see the guide-display tvg-shift.
      const rawStart = programme.rawStart ?? programme.start
      const rawStop = programme.rawStop ?? programme.stop
      const canReplay = isPast && !isCurrent && channelSupportsCatchup(channel) && isCatchupPlayable(channel, rawStart, nowMs)

      const row = document.createElement("button")
      row.type = "button"
      row.className =
        "relative flex min-h-14 w-full flex-col gap-1 rounded-lg px-3 py-2 text-start outline-none " +
        "hover:bg-surface-2 tv-focus-inset" +
        (isPast && !canReplay && !isCurrent ? " text-fg-3" : "")

      const topLine = document.createElement("span")
      topLine.className = "flex items-center gap-2 text-xs text-fg-3 tabular-nums"
      const timeEl = document.createElement("span")
      timeEl.textContent = formatTimeRange(programme.start, programme.stop, getActiveLocale())
      topLine.appendChild(timeEl)
      if (canReplay) {
        const pill = document.createElement("span")
        pill.className = "rounded-full border border-line px-1.5 py-0.5 text-2xs text-fg-2"
        pill.textContent = t("catchup.badge")
        topLine.appendChild(pill)
      }
      row.appendChild(topLine)

      const titleEl = document.createElement("span")
      titleEl.className = "truncate text-sm font-medium"
      titleEl.textContent = programme.title
      row.appendChild(titleEl)

      if (isCurrent && nowNext.current) {
        const accent = document.createElement("span")
        accent.setAttribute("aria-hidden", "true")
        accent.className = "absolute inset-y-2 left-0 w-[3px] rounded-full bg-accent"
        row.appendChild(accent)

        const track = document.createElement("span")
        track.className = "mt-1 block h-[2px] w-full overflow-hidden rounded-full bg-line"
        const fill = document.createElement("span")
        fill.className = "block h-full rounded-full bg-accent"
        fill.style.width = `${nowNext.current.progress * 100}%`
        track.appendChild(fill)
        row.appendChild(track)
      }

      row.addEventListener("click", () => {
        if (isCurrent) {
          activateChannel(channel)
        } else if (canReplay) {
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
        } else {
          openProgrammeDialog({
            title: programme.title,
            desc: programme.desc,
            start: programme.start,
            stop: programme.stop,
            channelName: channel.name,
            channelId: channel.id,
          })
        }
      })

      return row
    }

    function renderGuide(channel: LiveChannel | null): void {
      if (!refs) return
      state.guideChannel = channel
      renderGuideHeader(channel)
      refs.guideTrack.replaceChildren()
      if (!channel) return

      const epgState = getProgrammesSync(state.playlistId)
      if (!epgState) return // background load may still be in flight; EPG_LOADED_EVENT repaints once it lands

      const tvgId = effectiveTvgId(channel, state.playlistId)
      const dayProgrammes = tvgId ? epgState.programmes.get(tvgId) : undefined
      const rows = programmesForDay(dayProgrammes, startOfToday())
      if (!rows.length) {
        const empty = document.createElement("p")
        empty.className = "px-1 py-2 text-sm text-fg-3"
        empty.textContent = t("tv.live.noGuide")
        refs.guideTrack.appendChild(empty)
        return
      }

      const nowMs = Date.now()
      const nowNext = computeNowNext(epgState.programmes, channel, state.playlistId, nowMs)
      const fragment = document.createDocumentFragment()
      for (const programme of rows) fragment.appendChild(buildGuideRow(channel, programme, nowNext, nowMs))
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

    function onChannelsClick(event: Event): void {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-channel-id]")
      const channelId = target?.dataset.channelId
      const channel = channelId ? state.channelById.get(channelId) : null
      if (channel) activateChannel(channel)
    }

    function onChannelsFocusIn(event: FocusEvent): void {
      if (!refs) return
      const row = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-channel-id]")
      if (!row) return
      const rows = refs.channelsTrack.querySelectorAll("[data-channel-id]")
      if (rows[rows.length - 1] === row) renderChannelChunk()
      if (row.dataset.channelId) scheduleGuideUpdate(row.dataset.channelId)
    }

    function focusChannelRow(channelId: string): void {
      if (!refs) return
      let row = refs.channelsTrack.querySelector<HTMLElement>(`[data-channel-id="${CSS.escape(channelId)}"]`)
      while (!row && state.rendered < state.displayed.length) {
        renderChannelChunk()
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

      for (let i = 0; i < SKELETON_ROW_COUNT; i++) refs.channelsTrack.appendChild(buildSkeletonRow())

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

      const channelsColumnHeight = refs.channelsScroller.clientHeight || window.innerHeight
      unsubs.push(keepFocusedInView(refs.groupsScroller, "y", GROUPS_KEEP_IN_VIEW_OFFSET))
      unsubs.push(keepFocusedInView(refs.channelsScroller, "y", Math.round(channelsColumnHeight * 0.35)))
      unsubs.push(keepFocusedInView(refs.guideScroller, "y", GUIDE_KEEP_IN_VIEW_OFFSET))

      if (typeof IntersectionObserver !== "undefined") {
        observer = new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) renderChannelChunk()
          },
          { root: refs.channelsScroller, rootMargin: "200px" }
        )
      }

      refs.groupsTrack.addEventListener("click", onGroupsClick)
      refs.channelsTrack.addEventListener("click", onChannelsClick)
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
      document.addEventListener(LOCALE_EVENT, applyLocale)
      tickTimer = setInterval(tick, TICK_INTERVAL_MS)
    }

    function onEpgLoaded(event: Event): void {
      const detail = (event as CustomEvent).detail
      if (detail?.playlistId && detail.playlistId !== state.playlistId) return
      tick()
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
      observer?.disconnect()
      document.removeEventListener(EPG_LOADED_EVENT, onEpgLoaded)
      document.removeEventListener(LOCALE_EVENT, applyLocale)
      for (const unsub of unsubs) unsub()
      root.replaceChildren()
    }
  },
}

export default view
