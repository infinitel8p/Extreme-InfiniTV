// Shared TV home rail: header + horizontal card track with spatial-nav focus memory.

import { t } from "@/scripts/lib/i18n"
import { registerFocusSection, keepFocusedInView, remPx } from "@/scripts/tv/focus"
import { releaseCachedImages } from "@/scripts/lib/img-cache.ts"
import { motionAllowed, TV_EASE, memoryConservative } from "@/scripts/tv/motion"
import { neighboursOf, warmImageUrl } from "@/scripts/tv/prefetch"
import { createCard, updateCard, cardEntryKey, type CardItem } from "./card"

const RAIL_LEFT_OFFSET_REM = 1
const SKELETON_COUNT = 6
const SKELETON_FADE_MS = 200
const PREFETCH_RADIUS = 2
const NEW_CARD_DURATION_MS = 220
const NEW_CARD_STAGGER_MS = 30
const NEW_CARD_STAGGER_CAP = 10

export interface RailOptions {
  title: string
  focusSectionId: string
}

export interface RailSetItemsOptions {
  animateNew?: boolean
  /** New cards at this index or earlier skip lazy-loading - for rails close to the fold. */
  eagerCount?: number
}

export interface RailHandle {
  el: HTMLElement
  setLoading(): void
  setItems(items: CardItem[], options?: RailSetItemsOptions): void
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
  scroller.className = "overflow-hidden p-[var(--tv-focus-pad)] -m-[var(--tv-focus-pad)]"
  const track = document.createElement("div")
  track.dataset.railTrack = "1"
  track.className = "flex items-start gap-4 py-1"
  scroller.appendChild(track)

  el.append(head, scroller)

  const unregisterSection = registerFocusSection(options.focusSectionId, scroller, {
    enterTo: "last-focused",
    restrict: "self-first",
  })
  const unregisterKeepInView = keepFocusedInView(scroller, "x", () => remPx(RAIL_LEFT_OFFSET_REM))

  let isSkeletonState = false

  function onFocusIn(event: FocusEvent): void {
    const target = event.target
    const focusedCard = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-focus-key]") : null
    if (!focusedCard || !track.contains(focusedCard)) return
    for (const neighbour of neighboursOf(track, focusedCard, PREFETCH_RADIUS)) {
      warmImageUrl(neighbour.dataset.prefetchUrl)
    }
  }
  const prefetchOnFocus = !memoryConservative()
  if (prefetchOnFocus) scroller.addEventListener("focusin", onFocusIn)

  function setLoading(): void {
    el.hidden = false
    count.textContent = ""
    isSkeletonState = true
    releaseCachedImages(track)
    track.replaceChildren()
    for (let i = 0; i < SKELETON_COUNT; i++) track.appendChild(buildSkeletonCard())
  }

  function animateNewCard(node: HTMLElement, newCardIndex: number): void {
    if (!motionAllowed()) return
    node.animate(
      [
        { opacity: 0, transform: "translateY(0.5rem)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      {
        duration: NEW_CARD_DURATION_MS,
        delay: Math.min(newCardIndex, NEW_CARD_STAGGER_CAP - 1) * NEW_CARD_STAGGER_MS,
        easing: TV_EASE,
        fill: "backwards",
      }
    )
  }

  function reconcileItems(items: CardItem[], animateNew: boolean, eagerCount: number): void {
    const existingByKey = new Map<string, HTMLElement>()
    for (const child of Array.from(track.children) as HTMLElement[]) {
      const key = child.dataset.entryKey
      if (key) existingByKey.set(key, child)
    }

    const usedKeys = new Set<string>()
    let previousNode: HTMLElement | null = null
    let newCardIndex = 0

    items.forEach((item, index) => {
      const key = cardEntryKey(item)
      usedKeys.add(key)
      let node = existingByKey.get(key)
      const isNewCard = !node
      if (node) updateCard(node, item)
      else node = createCard(item, { eager: index < eagerCount })
      const insertBeforeNode: ChildNode | null = previousNode ? previousNode.nextSibling : track.firstChild
      if (insertBeforeNode !== node) track.insertBefore(node, insertBeforeNode)
      previousNode = node
      if (isNewCard && animateNew) animateNewCard(node, newCardIndex++)
    })

    for (const [key, node] of existingByKey) {
      if (usedKeys.has(key)) continue
      releaseCachedImages(node)
      node.remove()
    }
  }

  function setItems(items: CardItem[], options?: RailSetItemsOptions): void {
    const animateNew = options?.animateNew ?? true
    const eagerCount = options?.eagerCount ?? 0
    if (!items.length) {
      isSkeletonState = false
      releaseCachedImages(track)
      el.hidden = true
      track.replaceChildren()
      return
    }
    el.hidden = false
    count.textContent = t("strip.itemCount", { count: items.length })

    if (isSkeletonState && motionAllowed()) {
      const skeletonFadeOut = track.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: SKELETON_FADE_MS,
        easing: "ease-out",
      })
      skeletonFadeOut.onfinish = () => {
        releaseCachedImages(track)
        track.replaceChildren()
        isSkeletonState = false
        reconcileItems(items, animateNew, eagerCount)
      }
      return
    }

    if (isSkeletonState) {
      releaseCachedImages(track)
      track.replaceChildren()
    }
    isSkeletonState = false
    reconcileItems(items, animateNew, eagerCount)
  }

  function destroy(): void {
    if (prefetchOnFocus) scroller.removeEventListener("focusin", onFocusIn)
    releaseCachedImages(track)
    unregisterSection()
    unregisterKeepInView()
    el.remove()
  }

  return { el, setLoading, setItems, destroy }
}
