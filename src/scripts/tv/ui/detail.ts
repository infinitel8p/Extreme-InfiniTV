// Shared TV detail-page chrome: hero band (backdrop/poster/title/meta/description) + action row + sections container.

import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { t } from "@/scripts/lib/i18n"
import { registerFocusSection } from "@/scripts/tv/focus"

const ACTIONS_FOCUS_SECTION_ID = "tv-detail-actions"
const DESCRIPTION_FOCUS_SECTION_ID = "tv-detail-description"

export interface DetailHero {
  backdropUrl: string | null
  posterUrl: string | null
  title: string
  subtitle: string
  metaChips: string[]
  description: string
  rating?: string | null
}

export interface DetailAction {
  id: string
  label: string
  icon?: string
  primary?: boolean
  pressed?: boolean
  disabled?: boolean
  onActivate(): void
}

export interface DetailChromeHandle {
  el: HTMLElement
  setHero(hero: DetailHero): void
  setActions(actions: DetailAction[]): void
  setSkeleton(on: boolean): void
  sections: HTMLElement
  destroy(): void
}

const CHIP_CLASS = "rounded-full border border-line px-2 py-0.5 text-xs text-fg-2"
const RATING_CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-full border border-accent/50 px-2 py-0.5 text-xs font-medium text-accent"
const RATING_STAR_SVG =
  '<svg viewBox="0 0 24 24" width="0.9em" height="0.9em" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z"/></svg>'

const ACTION_BASE_CLASS =
  "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-2xl px-4 text-sm font-semibold outline-none " +
  "tv-focus-inset disabled:opacity-40"

function actionVariantClass(action: DetailAction): string {
  if (action.primary) return "bg-accent text-bg hover:opacity-90"
  if (action.pressed) return "bg-surface-3 text-accent"
  return "bg-surface-2 text-fg hover:bg-surface-3"
}

function buildActionButton(action: DetailAction): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.dataset.focusKey = `action:${action.id}`
  if (action.primary) button.dataset.tvAutofocus = ""
  button.disabled = !!action.disabled
  button.setAttribute("aria-pressed", String(!!action.pressed))
  button.className = `${ACTION_BASE_CLASS} ${actionVariantClass(action)}`

  if (action.icon) {
    const iconWrap = document.createElement("span")
    iconWrap.className = "inline-flex text-base"
    iconWrap.innerHTML = action.icon
    button.appendChild(iconWrap)
  }

  const labelEl = document.createElement("span")
  if (action.primary) labelEl.className = "max-w-[20rem] truncate"
  labelEl.textContent = action.label
  button.appendChild(labelEl)

  button.addEventListener("click", () => {
    if (!action.disabled) action.onActivate()
  })
  return button
}

function buildSkeletonBlock(className: string): HTMLDivElement {
  const block = document.createElement("div")
  block.className = `animate-pulse rounded-xl bg-surface-3 ${className}`
  return block
}

export function createDetailChrome(root: HTMLElement): DetailChromeHandle {
  const el = document.createElement("div")
  el.className = "flex flex-col gap-6 pb-10"

  const heroSection = document.createElement("section")
  heroSection.className = "relative isolate min-h-[18rem] w-full overflow-hidden rounded-2xl bg-black/40"

  const heroSkeleton = document.createElement("div")
  heroSkeleton.className = "flex h-full items-end gap-6 p-6"
  heroSkeleton.append(
    buildSkeletonBlock("aspect-[2/3] w-44 shrink-0"),
    (() => {
      const column = document.createElement("div")
      column.className = "flex flex-1 flex-col gap-3"
      column.append(
        buildSkeletonBlock("h-8 w-2/3"),
        buildSkeletonBlock("h-4 w-1/3"),
        buildSkeletonBlock("h-16 w-full")
      )
      return column
    })()
  )

  const backdropWrap = document.createElement("div")
  backdropWrap.className = "absolute inset-0"
  const gradientLeft = document.createElement("div")
  gradientLeft.className = "absolute inset-0 bg-gradient-to-r from-bg via-bg/70 to-transparent"
  const gradientBottom = document.createElement("div")
  gradientBottom.className = "absolute inset-0 bg-gradient-to-t from-bg/50 via-transparent to-transparent"

  const heroContent = document.createElement("div")
  heroContent.className = "relative flex h-full items-end gap-6 p-6"

  const posterWrap = document.createElement("div")
  posterWrap.className = "isolate aspect-[2/3] w-44 shrink-0 overflow-hidden rounded-xl bg-black/40 shadow-lg"

  const textBlock = document.createElement("div")
  textBlock.className = "flex max-w-2xl flex-1 flex-col gap-2"

  const titleEl = document.createElement("h1")
  titleEl.className = "line-clamp-2 text-2xl font-semibold text-fg"

  const subtitleEl = document.createElement("p")
  subtitleEl.className = "text-sm text-fg-2"

  const chipsRow = document.createElement("div")
  chipsRow.className = "flex flex-wrap items-center gap-2"

  const descriptionWrap = document.createElement("div")
  descriptionWrap.id = DESCRIPTION_FOCUS_SECTION_ID
  descriptionWrap.className = "flex flex-col items-start gap-1"
  const descriptionEl = document.createElement("p")
  descriptionEl.className = "line-clamp-3 max-w-xl text-sm text-fg-2"
  const moreButton = document.createElement("button")
  moreButton.type = "button"
  moreButton.className =
    "rounded px-1 -mx-1 text-sm font-medium text-accent outline-none hover:underline tv-focus-inset"
  moreButton.hidden = true
  let descriptionExpanded = false
  moreButton.addEventListener("click", () => {
    descriptionExpanded = !descriptionExpanded
    descriptionEl.classList.toggle("line-clamp-3", !descriptionExpanded)
    moreButton.textContent = descriptionExpanded ? t("tv.detail.less") : t("tv.detail.more")
  })
  descriptionWrap.append(descriptionEl, moreButton)

  textBlock.append(titleEl, subtitleEl, chipsRow, descriptionWrap)
  heroContent.append(posterWrap, textBlock)
  heroSection.append(heroSkeleton, backdropWrap, gradientLeft, gradientBottom, heroContent)

  const actionsSkeleton = document.createElement("div")
  actionsSkeleton.className = "flex flex-wrap gap-3 px-2"
  actionsSkeleton.append(
    buildSkeletonBlock("h-11 w-28"),
    buildSkeletonBlock("h-11 w-11"),
    buildSkeletonBlock("h-11 w-11")
  )

  const actionsRow = document.createElement("div")
  actionsRow.id = "tv-detail-actions"
  actionsRow.className = "flex flex-wrap gap-3 px-2"

  const sections = document.createElement("div")
  sections.className = "flex flex-col gap-6"

  el.append(heroSection, actionsSkeleton, actionsRow, sections)
  root.appendChild(el)

  const unregisterActionsSection = registerFocusSection(ACTIONS_FOCUS_SECTION_ID, actionsRow, {
    leaveFor: { up: `@${DESCRIPTION_FOCUS_SECTION_ID}` },
  })
  const unregisterDescriptionSection = registerFocusSection(DESCRIPTION_FOCUS_SECTION_ID, descriptionWrap, {
    enterTo: "default-element",
    defaultElement: `#${DESCRIPTION_FOCUS_SECTION_ID} button`,
  })

  function pageScroller(): HTMLElement | null {
    for (let element: HTMLElement | null = el; element; element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight + 1) return element
    }
    return null
  }

  // Native focus-scroll leaves the hero above the viewport; the action row is the way back to it.
  function onActionsFocusIn(): void {
    const scroller = pageScroller()
    if (scroller && scroller.scrollTop !== 0) scroller.scrollTop = 0
  }
  actionsRow.addEventListener("focusin", onActionsFocusIn)

  function setBackdrop(backdropUrl: string | null, posterUrl: string | null): void {
    backdropWrap.replaceChildren()
    const imageUrl = backdropUrl || posterUrl
    if (!imageUrl) return
    const img = document.createElement("img")
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    img.className = backdropUrl
      ? "absolute inset-0 h-full w-full object-cover"
      : "absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-3xl saturate-150"
    backdropWrap.appendChild(img)
    mountCachedImage(img, imageUrl, "poster")
  }

  function setPoster(posterUrl: string | null): void {
    posterWrap.replaceChildren()
    if (!posterUrl) return
    const img = document.createElement("img")
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    img.className = "block h-full w-full object-cover"
    posterWrap.appendChild(img)
    mountCachedImage(img, posterUrl, "poster")
  }

  function setHero(hero: DetailHero): void {
    setBackdrop(hero.backdropUrl, hero.posterUrl)
    setPoster(hero.posterUrl)
    titleEl.textContent = hero.title
    subtitleEl.textContent = hero.subtitle

    chipsRow.replaceChildren()
    if (hero.rating) {
      const ratingChip = document.createElement("span")
      ratingChip.className = RATING_CHIP_CLASS
      ratingChip.innerHTML = `${RATING_STAR_SVG}<span>${hero.rating}</span>`
      chipsRow.appendChild(ratingChip)
    }
    for (const chipText of hero.metaChips) {
      if (!chipText) continue
      const chip = document.createElement("span")
      chip.className = CHIP_CLASS
      chip.textContent = chipText
      chipsRow.appendChild(chip)
    }

    descriptionExpanded = false
    descriptionEl.classList.add("line-clamp-3")
    descriptionEl.textContent = hero.description
    moreButton.textContent = t("tv.detail.more")
    // Only offer the toggle once the paragraph is tall enough to actually clip.
    requestAnimationFrame(() => {
      moreButton.hidden = descriptionEl.scrollHeight <= descriptionEl.clientHeight + 1
    })
  }

  function setActions(actions: DetailAction[]): void {
    actionsRow.replaceChildren()
    for (const action of actions) actionsRow.appendChild(buildActionButton(action))
  }

  function setSkeleton(on: boolean): void {
    heroSkeleton.hidden = !on
    heroContent.hidden = on
    actionsSkeleton.hidden = !on
    actionsRow.hidden = on
  }

  setSkeleton(true)

  function destroy(): void {
    actionsRow.removeEventListener("focusin", onActionsFocusIn)
    unregisterActionsSection()
    unregisterDescriptionSection()
    el.remove()
  }

  return { el, setHero, setActions, setSkeleton, sections, destroy }
}
