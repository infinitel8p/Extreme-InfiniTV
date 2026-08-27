// Shared TV home rail: header + horizontal card track with spatial-nav focus memory.

import { t } from "@/scripts/lib/i18n"
import { registerFocusSection, keepFocusedInView, remPx } from "@/scripts/tv/focus"
import { createCard, type CardItem } from "./card"

const RAIL_LEFT_OFFSET_REM = 1
const SKELETON_COUNT = 6

export interface RailOptions {
  title: string
  focusSectionId: string
}

export interface RailHandle {
  el: HTMLElement
  setLoading(): void
  setItems(items: CardItem[]): void
  destroy(): void
}

function buildSkeletonCard(): HTMLDivElement {
  const skeleton = document.createElement("div")
  skeleton.className = "aspect-[2/3] w-[9.5rem] shrink-0 animate-pulse rounded-xl bg-surface-2"
  return skeleton
}

export function createRail(options: RailOptions): RailHandle {
  const el = document.createElement("section")
  el.className = "flex flex-col gap-3"
  el.hidden = true

  const head = document.createElement("div")
  head.className = "flex items-baseline justify-between gap-4"
  const heading = document.createElement("h2")
  heading.className = "text-lg font-semibold text-fg"
  heading.textContent = options.title
  const count = document.createElement("span")
  count.className = "text-sm text-fg-3 tabular-nums"
  head.append(heading, count)

  const scroller = document.createElement("div")
  scroller.className = "overflow-hidden py-[var(--tv-focus-pad)] -my-[var(--tv-focus-pad)]"
  const track = document.createElement("div")
  track.className = "flex items-start gap-4 py-1"
  scroller.appendChild(track)

  el.append(head, scroller)

  const unregisterSection = registerFocusSection(options.focusSectionId, scroller, {
    enterTo: "last-focused",
    restrict: "self-first",
  })
  const unregisterKeepInView = keepFocusedInView(scroller, "x", () => remPx(RAIL_LEFT_OFFSET_REM))

  function setLoading(): void {
    el.hidden = false
    count.textContent = ""
    track.replaceChildren()
    for (let i = 0; i < SKELETON_COUNT; i++) track.appendChild(buildSkeletonCard())
  }

  function setItems(items: CardItem[]): void {
    if (!items.length) {
      el.hidden = true
      track.replaceChildren()
      return
    }
    el.hidden = false
    count.textContent = t("strip.itemCount", { count: items.length })
    track.replaceChildren()
    for (const item of items) track.appendChild(createCard(item))
  }

  function destroy(): void {
    unregisterSection()
    unregisterKeepInView()
    el.remove()
  }

  return { el, setLoading, setItems, destroy }
}
