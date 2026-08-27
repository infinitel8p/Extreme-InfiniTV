// TV Live: card-style row + guide-panel builders, mirroring ui/card.ts's live tile language.
import { t, getActiveLocale } from "@/scripts/lib/i18n"
import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { formatTimeRange, type Programme } from "@/scripts/lib/now-next"
import { channelSupportsCatchup, isCatchupPlayable, type CatchupCapableChannel } from "@/scripts/lib/catchup.ts"
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
  tile.className = `relative aspect-video shrink-0 overflow-hidden rounded-xl tv-clip-round bg-black/40 ${widthClass}`
  if (!logoUrl) return tile
  tile.appendChild(buildImg(logoUrl, "absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-xl saturate-150"))
  tile.appendChild(buildImg(logoUrl, "absolute inset-0 m-auto max-h-[65%] max-w-[65%] object-contain"))
  return tile
}

function buildLogoChip(logoUrl: string | null | undefined, widthClass: string): HTMLSpanElement {
  const chip = document.createElement("span")
  chip.setAttribute("aria-hidden", "true")
  chip.className =
    `grid aspect-video shrink-0 place-items-center overflow-hidden rounded-lg tv-clip-round-lg bg-surface-2 p-2 ring-1 ring-inset ring-line ${widthClass}`
  if (logoUrl) chip.appendChild(buildImg(logoUrl, "h-full w-full object-contain"))
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
  row.className = "grid min-h-[5.5rem] grid-cols-[2.5rem_7rem_minmax(0,1fr)] items-center gap-4 rounded-2xl bg-surface px-3 py-2"
  const number = document.createElement("span")
  number.className = "h-4 w-6 animate-pulse justify-self-end rounded bg-surface-2"
  const logo = document.createElement("span")
  logo.className = "aspect-video w-28 animate-pulse rounded-xl bg-surface-2"
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

export function buildChannelRow(channel: LiveChannel, index: number, isPlaying: boolean): HTMLButtonElement {
  const row = document.createElement("button")
  row.type = "button"
  row.className =
    "group/row relative grid min-h-[5.5rem] w-full grid-cols-[2.5rem_7rem_minmax(0,1fr)] items-center gap-4 " +
    "rounded-2xl bg-surface px-3 py-2 text-start outline-none hover:bg-surface-2 tv-focus-inset " +
    "data-[now-playing=true]:bg-surface-2"
  row.dataset.focusKey = `ch:${channel.id}`
  row.dataset.channelId = String(channel.id)
  if (isPlaying) row.dataset.nowPlaying = "true"

  const accentBar = document.createElement("span")
  accentBar.setAttribute("aria-hidden", "true")
  accentBar.className =
    "absolute inset-y-3 left-0 w-[3px] rounded-full bg-accent opacity-0 group-data-[now-playing=true]/row:opacity-100"
  row.appendChild(accentBar)

  const number = document.createElement("span")
  number.className = "w-10 text-right text-sm tabular-nums text-fg-3"
  number.textContent = String(channel.chno ?? index + 1)
  row.appendChild(number)

  row.appendChild(buildLogoTile(channel.logo, "w-28"))

  const textCol = document.createElement("span")
  textCol.className = "flex min-w-0 items-center gap-4"

  const mainCol = document.createElement("span")
  mainCol.className = "flex min-w-0 flex-1 flex-col gap-1.5"

  const nameLine = document.createElement("span")
  nameLine.className = "flex min-w-0 items-center gap-2"
  const nameText = document.createElement("span")
  nameText.className = "min-w-0 truncate text-base font-semibold text-fg"
  nameText.textContent = channel.name
  const playingPill = document.createElement("span")
  playingPill.className =
    "hidden shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-2xs font-medium text-accent group-data-[now-playing=true]/row:inline-flex"
  playingPill.textContent = t("cast.remote.statePlaying")
  nameLine.append(nameText, playingPill)

  const nowLine = document.createElement("span")
  nowLine.dataset.role = "now"
  nowLine.className = "truncate text-sm text-fg-2"
  const progressTrack = document.createElement("span")
  progressTrack.className = "block h-[3px] w-full overflow-hidden rounded-full bg-surface-3"
  const progressFill = document.createElement("span")
  progressFill.dataset.role = "progress"
  progressFill.className = "block h-full rounded-full bg-accent"
  progressTrack.appendChild(progressFill)
  mainCol.append(nameLine, nowLine, progressTrack)
  textCol.appendChild(mainCol)

  const nextLine = document.createElement("span")
  nextLine.dataset.role = "next"
  nextLine.className = "hidden max-w-[10rem] shrink-0 truncate text-sm text-fg-3 min-[1500px]:block"
  textCol.appendChild(nextLine)

  row.appendChild(textCol)
  return row
}

function buildHeroBackdrop(logoUrl: string | null | undefined): HTMLSpanElement {
  const wrap = document.createElement("span")
  wrap.setAttribute("aria-hidden", "true")
  wrap.className = "absolute inset-0 overflow-hidden"
  if (logoUrl) wrap.appendChild(buildImg(logoUrl, "h-full w-full scale-110 object-cover opacity-35 blur-3xl saturate-150"))
  return wrap
}

export function buildGuideHero(
  channel: LiveChannel,
  status: GuideStatus,
  current: Programme | null,
  currentProgress: number
): HTMLDivElement {
  const hero = document.createElement("div")
  hero.className = "relative min-h-[14rem] overflow-hidden rounded-2xl tv-clip-round-2xl bg-black/40 p-6"

  hero.appendChild(buildHeroBackdrop(channel.logo))
  const darken = document.createElement("span")
  darken.setAttribute("aria-hidden", "true")
  darken.className = "absolute inset-0 bg-gradient-to-t from-bg via-bg/55 to-bg/20"
  hero.appendChild(darken)

  const content = document.createElement("div")
  content.className = "relative flex flex-col gap-3"

  const identity = document.createElement("div")
  identity.className = "flex items-center gap-3"
  const name = document.createElement("span")
  name.className = "min-w-0 truncate text-base font-semibold text-fg"
  name.textContent = channel.name
  identity.append(buildLogoChip(channel.logo, "w-24"), name)
  content.appendChild(identity)

  if (status === "loading") {
    const line1 = document.createElement("span")
    line1.className = "h-6 w-2/3 max-w-sm animate-pulse rounded bg-surface-2"
    const line2 = document.createElement("span")
    line2.className = "h-4 w-1/3 max-w-xs animate-pulse rounded bg-surface-2"
    content.append(line1, line2)
  } else if (current) {
    const title = document.createElement("p")
    title.className = "line-clamp-2 text-xl font-semibold text-fg"
    title.textContent = current.title
    content.appendChild(title)

    const timeRow = document.createElement("div")
    timeRow.className = "flex flex-col gap-1.5"
    const time = document.createElement("span")
    time.className = "text-sm tabular-nums text-fg-2"
    time.textContent = formatTimeRange(current.start, current.stop, getActiveLocale())
    const track = document.createElement("span")
    track.className = "block h-1 w-full max-w-xs overflow-hidden rounded-full bg-surface-3"
    const fill = document.createElement("span")
    fill.className = "block h-full rounded-full bg-accent"
    fill.style.width = `${currentProgress * 100}%`
    track.appendChild(fill)
    timeRow.append(time, track)
    content.appendChild(timeRow)

    if (current.desc) {
      const desc = document.createElement("p")
      desc.className = "line-clamp-3 text-sm text-fg-2"
      desc.textContent = current.desc
      content.appendChild(desc)
    }
  } else if (status === "empty") {
    const empty = document.createElement("p")
    empty.className = "text-sm text-fg-3"
    empty.textContent = t("tv.live.noGuide")
    content.appendChild(empty)
  }

  hero.appendChild(content)
  return hero
}

export function buildUpNextHeading(): HTMLParagraphElement {
  const heading = document.createElement("p")
  heading.className = "px-1 pt-1 text-xs font-semibold uppercase tracking-wide text-fg-3"
  heading.textContent = t("detail.upNext")
  return heading
}

export function buildGuideRowSkeleton(): HTMLDivElement {
  const row = document.createElement("div")
  row.setAttribute("aria-hidden", "true")
  row.className = "flex min-h-10 items-center gap-3 rounded-lg px-3 py-2"
  const time = document.createElement("span")
  time.className = "h-3 w-14 shrink-0 animate-pulse rounded bg-surface-2"
  const title = document.createElement("span")
  title.className = "h-3 w-2/3 animate-pulse rounded bg-surface-2"
  row.append(time, title)
  return row
}

export function buildGuideRow(
  channel: LiveChannel,
  programme: Programme,
  nowMs: number,
  onReplay: (channel: LiveChannel, programme: Programme, rawStart: number, rawStop: number) => void,
  onDetails: (channel: LiveChannel, programme: Programme) => void
): HTMLButtonElement {
  const rawStart = programme.rawStart ?? programme.start
  const rawStop = programme.rawStop ?? programme.stop
  const isPast = programme.stop <= nowMs
  const canReplay = isPast && channelSupportsCatchup(channel) && isCatchupPlayable(channel, rawStart, nowMs)

  const row = document.createElement("button")
  row.type = "button"
  row.className =
    "flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-start outline-none " +
    "hover:bg-surface-2 tv-focus-inset" +
    (isPast && !canReplay ? " opacity-60" : "")

  const time = document.createElement("span")
  time.className = "w-32 shrink-0 whitespace-nowrap text-xs tabular-nums text-fg-3"
  time.textContent = formatTimeRange(programme.start, programme.stop, getActiveLocale())
  row.appendChild(time)

  const title = document.createElement("span")
  title.className = "min-w-0 flex-1 truncate text-sm"
  title.textContent = programme.title
  row.appendChild(title)

  if (canReplay) {
    const pill = document.createElement("span")
    pill.className = "shrink-0 rounded-full border border-line px-1.5 py-0.5 text-2xs text-fg-2"
    pill.textContent = t("catchup.badge")
    row.appendChild(pill)
  }

  row.addEventListener("click", () => {
    if (canReplay) onReplay(channel, programme, rawStart, rawStop)
    else onDetails(channel, programme)
  })

  return row
}
