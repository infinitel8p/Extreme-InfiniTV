// Shared TV home hero band: left-aligned text over a right-weighted backdrop.

import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { registerFocusSection } from "@/scripts/tv/focus"

const HERO_FOCUS_SECTION_ID = "tv-home-hero"
export const HERO_FOCUS_KEY = "hero"

export interface HeroCta {
  href: string
  label: string
  autofocus?: boolean
}

export interface HeroItem {
  eyebrow: string
  title: string
  meta: string
  progressPercent?: number | null
  imageUrl?: string | null
  imageKind?: "poster" | "logo"
  cta?: HeroCta
  /** Enter/OK on the hero itself when there's no `cta` (poster items navigate, live items tune in). */
  onActivate?: () => void
}

export interface HeroHandle {
  show(item: HeroItem): void
  clear(): void
  destroy(): void
}

export function createHero(root: HTMLElement): HeroHandle {
  const section = document.createElement("section")
  section.className =
    "relative isolate h-[40vh] min-h-[13rem] w-full shrink-0 overflow-hidden rounded-2xl bg-black/40"

  const backdropWrap = document.createElement("div")
  backdropWrap.className = "absolute inset-0"

  const gradientLeft = document.createElement("div")
  gradientLeft.className = "absolute inset-0 bg-gradient-to-r from-bg via-bg/75 to-transparent"
  const gradientBottom = document.createElement("div")
  gradientBottom.className = "absolute inset-0 bg-gradient-to-t from-bg/40 via-transparent to-transparent"

  const textBlock = document.createElement("div")
  textBlock.className = "relative flex h-full max-w-xl flex-col justify-end gap-2 p-6"

  const eyebrow = document.createElement("p")
  eyebrow.className = "text-xs font-semibold uppercase tracking-wide text-accent"
  const title = document.createElement("h1")
  title.className = "line-clamp-2 text-3xl font-semibold text-fg"
  const meta = document.createElement("p")
  meta.className = "text-sm text-fg-2"

  const progressTrack = document.createElement("div")
  progressTrack.className = "mt-1 h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-white/15"
  progressTrack.hidden = true
  const progressFill = document.createElement("div")
  progressFill.className = "h-full rounded-full bg-accent"
  progressTrack.appendChild(progressFill)

  let ctaEl: HTMLAnchorElement | null = null

  const activateButton = document.createElement("button")
  activateButton.type = "button"
  activateButton.dataset.focusKey = HERO_FOCUS_KEY
  activateButton.className = "absolute inset-0 z-10 rounded-2xl outline-none tv-focus-ring"
  activateButton.hidden = true

  textBlock.append(eyebrow, title, meta, progressTrack)
  section.append(backdropWrap, gradientLeft, gradientBottom, textBlock, activateButton)
  root.appendChild(section)

  const unregisterHeroSection = registerFocusSection(HERO_FOCUS_SECTION_ID, section)

  function setBackdrop(imageUrl: string | null | undefined, imageKind: "poster" | "logo" | undefined): void {
    backdropWrap.replaceChildren()
    if (!imageUrl) return
    if (imageKind === "logo") {
      const blurred = document.createElement("img")
      blurred.alt = ""
      blurred.setAttribute("aria-hidden", "true")
      blurred.loading = "lazy"
      blurred.decoding = "async"
      blurred.className =
        "absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-3xl saturate-150"
      backdropWrap.appendChild(blurred)
      mountCachedImage(blurred, imageUrl, "logo")

      const contained = document.createElement("img")
      contained.alt = ""
      contained.loading = "lazy"
      contained.decoding = "async"
      contained.className =
        "absolute right-[6%] top-1/2 max-h-[55%] max-w-[42%] -translate-y-1/2 object-contain"
      backdropWrap.appendChild(contained)
      mountCachedImage(contained, imageUrl, "logo")
      return
    }
    const img = document.createElement("img")
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    img.className = "absolute inset-0 h-full w-full object-cover"
    backdropWrap.appendChild(img)
    mountCachedImage(img, imageUrl, "poster")
  }

  function setCta(cta: HeroCta | undefined): void {
    if (ctaEl) {
      ctaEl.remove()
      ctaEl = null
    }
    if (!cta) return
    ctaEl = document.createElement("a")
    ctaEl.href = cta.href
    if (cta.autofocus) ctaEl.dataset.tvAutofocus = ""
    ctaEl.className =
      "mt-2 inline-flex min-h-11 w-fit items-center gap-2 rounded-xl bg-accent px-5 text-sm " +
      "font-semibold text-bg outline-none tv-focus-inset"
    ctaEl.textContent = cta.label
    textBlock.appendChild(ctaEl)
  }

  function setActivate(item: HeroItem): void {
    if (item.cta || !item.onActivate) {
      activateButton.hidden = true
      activateButton.onclick = null
      return
    }
    const onActivate = item.onActivate
    activateButton.hidden = false
    activateButton.setAttribute("aria-label", item.title)
    activateButton.onclick = () => onActivate()
  }

  function show(item: HeroItem): void {
    eyebrow.textContent = item.eyebrow
    title.textContent = item.title
    meta.textContent = item.meta
    if (item.progressPercent != null && item.progressPercent > 0) {
      progressTrack.hidden = false
      progressFill.style.width = `${Math.max(0, Math.min(100, item.progressPercent))}%`
    } else {
      progressTrack.hidden = true
    }
    setBackdrop(item.imageUrl, item.imageKind)
    setCta(item.cta)
    setActivate(item)
  }

  function clear(): void {
    eyebrow.textContent = ""
    title.textContent = ""
    meta.textContent = ""
    progressTrack.hidden = true
    backdropWrap.replaceChildren()
    setCta(undefined)
    activateButton.hidden = true
    activateButton.onclick = null
  }

  function destroy(): void {
    unregisterHeroSection()
    section.remove()
  }

  return { show, clear, destroy }
}
