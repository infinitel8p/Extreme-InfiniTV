// TV Live: card-style row + guide-panel builders, mirroring ui/card.ts's live tile language.
import { t, getActiveLocale } from "@/scripts/lib/i18n"
import { mountCachedImage, releaseCachedImages } from "@/scripts/lib/img-cache.ts"
import { formatTimeRange, type Programme } from "@/scripts/lib/now-next"
import { channelSupportsCatchup, isCatchupPlayable, type CatchupCapableChannel } from "@/scripts/lib/catchup.ts"
import { STAR_OUTLINE, STAR_FILLED } from "@/scripts/lib/entry-card.ts"
import { motionAllowed, TV_EASE } from "@/scripts/tv/motion"
import type { CastChannel, CastChannelGroup } from "@/scripts/lib/tv-cast-channel-list"

export interface LiveChannel extends CastChannel, CatchupCapableChannel {
  tvgShift?: number | null
}

export type GuideStatus = "loading" | "empty" | "ready"

function buildImg(logoUrl: string, className: string): HTMLImageElement {
  const img = document.createElement("img")
  img.alt = ""
  img.loading = "lazy"
  img.decoding = "async"
  img.referrerPolicy = "no-referrer"
  img.className = className
  mountCachedImage(img, logoUrl, "logo")
  return img
}

/** 16:9 tile with the logo blurred behind itself on a dark panel, per ui/card.ts's live tile. */
function buildLogoTile(logoUrl: string | null | undefined, widthClass: string): HTMLSpanElement {
  const tile = document.createElement("span")
  tile.setAttribute("aria-hidden", "true")
  tile.className =
    `relative isolate aspect-video shrink-0 overflow-hidden rounded-xl bg-black/40 tv-edge-mask ${widthClass}`
  if (!logoUrl) return tile
  tile.appendChild(buildImg(logoUrl, "absolute inset-0 h-full w-full scale-125 object-cover opacity-25 blur-xl saturate-150"))
  tile.appendChild(buildImg(logoUrl, "absolute inset-0 m-auto max-h-[75%] max-w-[75%] object-contain"))
  return tile
}

// Always includes an <img>, even with no logo yet, so a persistent panel can mount one later.
function buildLogoChip(logoUrl: string | null | undefined, widthClass: string): HTMLSpanElement {
  const chip = document.createElement("span")
  chip.setAttribute("aria-hidden", "true")
  chip.className =
    `relative grid isolate aspect-video shrink-0 place-items-center overflow-hidden rounded-lg bg-black/40 p-2 ring-1 ring-inset ring-line tv-edge-mask ${widthClass}`
  // min-0: without it the grid track grows to the logo's intrinsic size and h-full/w-full clip it.
  const img = document.createElement("img")
  img.alt = ""
  img.decoding = "async"
  img.referrerPolicy = "no-referrer"
  img.className = "h-full w-full min-h-0 min-w-0 object-contain"
  chip.appendChild(img)
  if (logoUrl) mountCachedImage(img, logoUrl, "logo")
  return chip
}

export function buildGroupButton(group: CastChannelGroup, isActive: boolean): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.dataset.focusKey = `group:${group.key}`
  button.dataset.groupKey = group.key
  button.dataset.active = isActive ? "true" : "false"
  button.className =
    "flex min-h-[3.25rem] w-full items-center gap-3 rounded-2xl px-4 text-start text-fg-2 outline-none " +
    "transition-colors hover:bg-surface-2 tv-focus-inset " +
    "data-[active=true]:bg-accent/15 data-[active=true]:font-medium data-[active=true]:text-accent"

  const label = document.createElement("span")
  label.className = "min-w-0 flex-1 truncate text-sm"
  label.textContent = group.label

  const count = document.createElement("span")
  count.className = "shrink-0 text-xs tabular-nums text-fg-3"
  count.textContent = group.channels.length.toLocaleString()

  button.append(label, count)
  return button
}

export function buildChannelRowSkeleton(): HTMLDivElement {
  const row = document.createElement("div")
  row.setAttribute("aria-hidden", "true")
  row.className = "grid min-h-[4rem] grid-cols-[2rem_5rem_minmax(0,1fr)] items-center gap-3 rounded-2xl bg-surface px-3 py-2"
  const number = document.createElement("span")
  number.className = "h-4 w-5 animate-pulse justify-self-end rounded bg-surface-2"
  const logo = document.createElement("span")
  logo.className = "aspect-video w-20 animate-pulse rounded-xl bg-surface-2"
  const text = document.createElement("span")
  text.className = "flex min-w-0 flex-col justify-center gap-2"
  const line1 = document.createElement("span")
  line1.className = "h-4 w-1/2 animate-pulse rounded bg-surface-2"
  const line2 = document.createElement("span")
  line2.className = "h-3 w-1/3 animate-pulse rounded bg-surface-2"
  text.append(line1, line2)
  row.append(number, logo, text)
  return row
}

export function buildChannelRow(channel: LiveChannel, index: number, isPlaying: boolean, favorite: boolean): HTMLButtonElement {
  const row = document.createElement("button")
  row.type = "button"
  row.className =
    "group/row relative grid min-h-[4rem] w-full grid-cols-[2rem_5rem_minmax(0,1fr)] items-center gap-3 " +
    "rounded-2xl bg-surface px-3 py-2 text-start outline-none hover:bg-surface-2 tv-focus-inset " +
    "data-[now-playing=true]:bg-surface-2"
  row.dataset.focusKey = `ch:${channel.id}`
  row.dataset.channelId = String(channel.id)
  row.dataset.channelKey = String(channel.id)
  if (isPlaying) row.dataset.nowPlaying = "true"

  const accentBar = document.createElement("span")
  accentBar.setAttribute("aria-hidden", "true")
  accentBar.className =
    "absolute inset-y-3 left-0 w-[3px] rounded-full bg-accent opacity-0 group-data-[now-playing=true]/row:opacity-100"
  row.appendChild(accentBar)

  const number = document.createElement("span")
  number.className = "w-8 text-right text-sm tabular-nums text-fg-3"
  number.textContent = String(channel.chno ?? index + 1)
  row.appendChild(number)

  row.appendChild(buildLogoTile(channel.logo, "w-20"))

  const textCol = document.createElement("span")
  textCol.className = "flex min-w-0 items-center gap-4"

  const mainCol = document.createElement("span")
  mainCol.className = "flex min-w-0 flex-1 flex-col gap-1.5"

  const nameLine = document.createElement("span")
  nameLine.className = "flex min-w-0 items-center gap-2"
  const nameText = document.createElement("span")
  nameText.className = "min-w-0 truncate text-base font-semibold text-fg"
  nameText.textContent = channel.name
  const favStar = document.createElement("span")
  favStar.dataset.role = "fav"
  favStar.setAttribute("aria-hidden", "true")
  favStar.className = `shrink-0 text-xs text-accent${favorite ? "" : " hidden"}`
  favStar.innerHTML = STAR_FILLED
  const playingPill = document.createElement("span")
  playingPill.className =
    "hidden shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-2xs font-medium text-accent group-data-[now-playing=true]/row:inline-flex"
  playingPill.textContent = t("cast.remote.statePlaying")
  nameLine.append(nameText, favStar, playingPill)

  const nowLine = document.createElement("span")
  nowLine.dataset.role = "now"
  nowLine.className = "truncate text-sm text-fg-2"
  const progressTrack = document.createElement("span")
  progressTrack.className = "block h-[3px] w-full overflow-hidden rounded-full bg-surface-3"
  const progressFill = document.createElement("span")
  progressFill.dataset.role = "progress"
  progressFill.className = "block h-full w-full origin-left rounded-full bg-accent"
  progressFill.style.transform = "scaleX(0)"
  progressTrack.appendChild(progressFill)
  mainCol.append(nameLine, nowLine, progressTrack)
  textCol.appendChild(mainCol)

  const nextLine = document.createElement("span")
  nextLine.dataset.role = "next"
  nextLine.className = "hidden max-w-[10rem] shrink-0 truncate text-sm text-fg-3"
  textCol.appendChild(nextLine)

  row.appendChild(textCol)
  return row
}

const BACKDROP_FADE_MS = 360
const BACKDROP_DECODE_TIMEOUT_MS = 400
const TEXT_DIP_MS = 140
const PROGRESS_ANIMATE_MS = 240

function buildBackdropLayer(): HTMLSpanElement {
  const layer = document.createElement("span")
  layer.setAttribute("aria-hidden", "true")
  layer.className = "absolute inset-0"
  layer.style.opacity = "0"
  const img = document.createElement("img")
  img.alt = ""
  img.decoding = "async"
  img.referrerPolicy = "no-referrer"
  img.className = "h-full w-full scale-125 object-cover opacity-35 blur-3xl saturate-150"
  layer.appendChild(img)
  return layer
}

/** Resolves once `img` has decoded, or after `timeoutMs` - whichever comes first. */
function waitForImageReady(img: HTMLImageElement, timeoutMs: number): Promise<void> {
  const ready =
    typeof img.decode === "function"
      ? img.decode().catch(() => {})
      : new Promise<void>((resolve) => {
          if (img.complete) resolve()
          else img.addEventListener("load", () => resolve(), { once: true })
        })
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  return Promise.race([ready, timeout])
}

/** Animates `fill`'s scaleX from its current inline value to `fraction`; direct set when not animating. */
function setProgressFraction(fill: HTMLElement, fraction: number, animate: boolean): void {
  const clamped = Math.max(0, Math.min(1, fraction))
  if (!animate || !motionAllowed()) {
    fill.style.transform = `scaleX(${clamped})`
    return
  }
  const previous = parseFloat(fill.dataset.fraction || "0") || 0
  fill.animate([{ transform: `scaleX(${previous})` }, { transform: `scaleX(${clamped})` }], {
    duration: PROGRESS_ANIMATE_MS,
    easing: TV_EASE,
    fill: "forwards",
  })
  fill.style.transform = `scaleX(${clamped})`
  fill.dataset.fraction = String(clamped)
}

interface GuideRowState {
  channel: LiveChannel
  programme: Programme
  canReplay: boolean
}

function createGuideRow(
  onReplay: (channel: LiveChannel, programme: Programme, rawStart: number, rawStop: number) => void,
  onDetails: (channel: LiveChannel, programme: Programme) => void
): { el: HTMLButtonElement; update(state: GuideRowState): void } {
  const row = document.createElement("button")
  row.type = "button"
  row.className = "flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-start outline-none hover:bg-surface-2 tv-focus-inset"

  const time = document.createElement("span")
  time.className = "w-24 shrink-0 whitespace-nowrap text-xs tabular-nums text-fg-3"
  const title = document.createElement("span")
  title.className = "min-w-0 flex-1 truncate text-sm"
  const pill = document.createElement("span")
  pill.className = "hidden shrink-0 rounded-full border border-line px-1.5 py-0.5 text-2xs text-fg-2"
  pill.textContent = t("catchup.badge")
  row.append(time, title, pill)

  let state: GuideRowState | null = null
  row.addEventListener("click", () => {
    if (!state) return
    const rawStart = state.programme.rawStart ?? state.programme.start
    const rawStop = state.programme.rawStop ?? state.programme.stop
    if (state.canReplay) onReplay(state.channel, state.programme, rawStart, rawStop)
    else onDetails(state.channel, state.programme)
  })

  function update(next: GuideRowState): void {
    state = next
    time.textContent = formatTimeRange(next.programme.start, next.programme.stop, getActiveLocale())
    title.textContent = next.programme.title
    pill.classList.toggle("hidden", !next.canReplay)
    row.classList.toggle("opacity-60", next.programme.stop <= Date.now() && !next.canReplay)
  }

  return { el: row, update }
}

export interface GuidePanelCallbacks {
  onToggleFavorite(channel: LiveChannel): void
  onReplay(channel: LiveChannel, programme: Programme, rawStart: number, rawStop: number): void
  onDetails(channel: LiveChannel, programme: Programme): void
}

export interface GuidePanelUpdate {
  channel: LiveChannel
  status: GuideStatus
  current: Programme | null
  currentProgress: number
  favorite: boolean
  upcoming: Programme[]
  nowMs: number
  /** False for tick/EPG-load refreshes: those patch in place with no crossfade or dip. */
  animate: boolean
}

export interface GuidePanelHandle {
  update(input: GuidePanelUpdate): void
  destroy(): void
}

/** Builds the guide hero + up-next list once into `container`, then patches in place on every update. */
export function createGuidePanel(container: HTMLElement, callbacks: GuidePanelCallbacks): GuidePanelHandle {
  const hero = document.createElement("div")
  hero.className = "relative isolate min-h-[10rem] overflow-hidden rounded-2xl bg-black/40 p-4 tv-edge-mask"

  const backdropWrap = document.createElement("span")
  backdropWrap.setAttribute("aria-hidden", "true")
  backdropWrap.className = "absolute inset-0 overflow-hidden"
  const layerA = buildBackdropLayer()
  const layerB = buildBackdropLayer()
  backdropWrap.append(layerA, layerB)
  hero.appendChild(backdropWrap)
  let activeLayer = layerA
  let inactiveLayer = layerB
  let backdropUrl: string | null | undefined = null
  let backdropGeneration = 0

  const darken = document.createElement("span")
  darken.setAttribute("aria-hidden", "true")
  darken.className = "absolute inset-0 bg-gradient-to-t from-bg via-bg/55 to-bg/20"
  hero.appendChild(darken)

  const content = document.createElement("div")
  content.className = "relative flex flex-col gap-3"
  hero.appendChild(content)

  const identity = document.createElement("div")
  identity.className = "flex items-start gap-3"
  const logoChip = buildLogoChip(null, "w-16")
  const logoImg = logoChip.querySelector("img") as HTMLImageElement | null
  const name = document.createElement("span")
  name.className = "min-h-10 min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-fg line-clamp-2"
  const favButton = document.createElement("button")
  favButton.type = "button"
  favButton.className =
    "flex size-9 shrink-0 items-center justify-center rounded-lg outline-none tv-focus-inset transition-colors hover:bg-surface-2"
  identity.append(logoChip, name, favButton)
  content.appendChild(identity)

  const programmeBlock = document.createElement("div")
  programmeBlock.className = "flex flex-col gap-3"
  content.appendChild(programmeBlock)

  let activeChannel: LiveChannel | null = null
  favButton.addEventListener("click", (event) => {
    event.stopPropagation()
    if (activeChannel) callbacks.onToggleFavorite(activeChannel)
  })

  const skeletonBlock = document.createElement("div")
  skeletonBlock.className = "flex flex-col gap-2"
  const skeletonLine1 = document.createElement("span")
  skeletonLine1.className = "h-5 w-2/3 max-w-sm animate-pulse rounded bg-surface-2"
  const skeletonLine2 = document.createElement("span")
  skeletonLine2.className = "h-4 w-1/3 max-w-xs animate-pulse rounded bg-surface-2"
  skeletonBlock.append(skeletonLine1, skeletonLine2)
  programmeBlock.appendChild(skeletonBlock)

  const emptyBlock = document.createElement("p")
  emptyBlock.className = "hidden text-sm text-fg-3"
  emptyBlock.textContent = t("tv.live.noGuide")
  programmeBlock.appendChild(emptyBlock)

  const currentBlock = document.createElement("div")
  currentBlock.className = "hidden flex-col gap-3"
  const currentTitle = document.createElement("p")
  currentTitle.className = "line-clamp-2 text-lg font-semibold text-fg"
  const timeRow = document.createElement("div")
  timeRow.className = "flex flex-col gap-1.5"
  const currentTime = document.createElement("span")
  currentTime.className = "text-xs tabular-nums text-fg-2"
  const progressTrack = document.createElement("span")
  progressTrack.className = "block h-1 w-full max-w-xs overflow-hidden rounded-full bg-surface-3"
  const progressFill = document.createElement("span")
  progressFill.className = "block h-full w-full origin-left rounded-full bg-accent"
  progressFill.style.transform = "scaleX(0)"
  progressTrack.appendChild(progressFill)
  timeRow.append(currentTime, progressTrack)
  const currentDesc = document.createElement("p")
  currentDesc.className = "hidden line-clamp-2 text-xs text-fg-2"
  currentBlock.append(currentTitle, timeRow, currentDesc)
  programmeBlock.appendChild(currentBlock)

  container.replaceChildren(hero)

  const upNextHeading = document.createElement("p")
  upNextHeading.className = "hidden px-1 pt-1 text-xs font-semibold uppercase tracking-wide text-fg-3"
  upNextHeading.textContent = t("detail.upNext")
  container.appendChild(upNextHeading)

  const upNextTrack = document.createElement("div")
  upNextTrack.className = "flex flex-col gap-1"
  container.appendChild(upNextTrack)

  const upNextRows = new Map<string, { el: HTMLButtonElement; update(state: GuideRowState): void }>()

  function reconcileUpNext(channel: LiveChannel, upcoming: Programme[], nowMs: number): void {
    const usedKeys = new Set<string>()
    let anchor = upNextTrack.firstChild
    for (const programme of upcoming) {
      const key = String(programme.start)
      usedKeys.add(key)
      let entry = upNextRows.get(key)
      if (!entry) {
        entry = createGuideRow(callbacks.onReplay, callbacks.onDetails)
        upNextRows.set(key, entry)
      }
      const rawStart = programme.rawStart ?? programme.start
      const canReplay = programme.stop <= nowMs && channelSupportsCatchup(channel) && isCatchupPlayable(channel, rawStart, nowMs)
      entry.update({ channel, programme, canReplay })
      if (anchor !== entry.el) upNextTrack.insertBefore(entry.el, anchor)
      anchor = entry.el.nextSibling
    }
    for (const [key, entry] of Array.from(upNextRows)) {
      if (usedKeys.has(key)) continue
      entry.el.remove()
      upNextRows.delete(key)
    }
    upNextHeading.classList.toggle("hidden", upcoming.length === 0)
  }

  async function swapBackdrop(logoUrl: string | null | undefined, animate: boolean): Promise<void> {
    if (logoUrl === backdropUrl) return
    backdropUrl = logoUrl
    const myGeneration = ++backdropGeneration
    const nextImg = inactiveLayer.querySelector("img") as HTMLImageElement

    if (!animate || !motionAllowed()) {
      if (logoUrl) nextImg.src = logoUrl
      else nextImg.removeAttribute("src")
      activeLayer.style.opacity = "0"
      releaseCachedImages(activeLayer)
      inactiveLayer.style.opacity = logoUrl ? "1" : "0"
      ;[activeLayer, inactiveLayer] = [inactiveLayer, activeLayer]
      return
    }

    if (logoUrl) {
      nextImg.src = logoUrl
      await waitForImageReady(nextImg, BACKDROP_DECODE_TIMEOUT_MS)
    } else {
      nextImg.removeAttribute("src")
    }
    if (myGeneration !== backdropGeneration) return

    const outgoing = activeLayer
    const incoming = inactiveLayer
    ;[activeLayer, inactiveLayer] = [incoming, outgoing]

    incoming.animate([{ opacity: 0 }, { opacity: logoUrl ? 1 : 0 }], { duration: BACKDROP_FADE_MS, easing: TV_EASE, fill: "forwards" })
    incoming.style.opacity = logoUrl ? "1" : "0"
    const outAnim = outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: BACKDROP_FADE_MS, easing: TV_EASE, fill: "forwards" })
    outAnim.finished
      .then(() => {
        outgoing.style.opacity = "0"
        if (myGeneration === backdropGeneration) {
          const outImg = outgoing.querySelector("img") as HTMLImageElement
          outImg.removeAttribute("src")
        }
      })
      .catch(() => {})
  }

  function applyIdentity(input: GuidePanelUpdate): void {
    name.textContent = input.channel.name
    favButton.dataset.focusKey = `guide-fav:${input.channel.id}`
    favButton.setAttribute("aria-label", t(input.favorite ? "detail.action.removeFavorite" : "detail.action.addFavorite"))
    favButton.setAttribute("aria-pressed", String(input.favorite))
    favButton.classList.toggle("text-accent", input.favorite)
    favButton.classList.toggle("text-fg-3", !input.favorite)
    favButton.classList.toggle("hover:text-fg", !input.favorite)
    favButton.innerHTML = `<span class="inline-flex text-base">${input.favorite ? STAR_FILLED : STAR_OUTLINE}</span>`
    if (logoImg) {
      releaseCachedImages(logoImg)
      if (input.channel.logo) mountCachedImage(logoImg, input.channel.logo, "logo")
      else logoImg.removeAttribute("src")
    }
  }

  function applyProgramme(input: GuidePanelUpdate): void {
    skeletonBlock.classList.toggle("hidden", input.status !== "loading")
    emptyBlock.classList.toggle("hidden", !(input.status === "empty" && !input.current))
    currentBlock.classList.toggle("hidden", !input.current)

    if (input.current) {
      currentTitle.textContent = input.current.title
      currentTime.textContent = formatTimeRange(input.current.start, input.current.stop, getActiveLocale())
      setProgressFraction(progressFill, input.currentProgress, input.animate)
      currentDesc.classList.toggle("hidden", !input.current.desc)
      currentDesc.textContent = input.current.desc || ""
    }

    reconcileUpNext(input.channel, input.upcoming, input.nowMs)
  }

  function update(input: GuidePanelUpdate): void {
    activeChannel = input.channel
    void swapBackdrop(input.channel.logo, input.animate)
    applyIdentity(input)

    if (!input.animate || !motionAllowed()) {
      applyProgramme(input)
      return
    }
    const dip = programmeBlock.animate([{ opacity: 1 }, { opacity: 0 }], { duration: TEXT_DIP_MS / 2, easing: TV_EASE, fill: "forwards" })
    dip.finished
      .then(() => {
        applyProgramme(input)
        programmeBlock.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TEXT_DIP_MS / 2, easing: TV_EASE, fill: "forwards" })
        programmeBlock.style.opacity = "1"
      })
      .catch(() => applyProgramme(input))
  }

  function destroy(): void {
    releaseCachedImages(container)
    upNextRows.clear()
  }

  return { update, destroy }
}
