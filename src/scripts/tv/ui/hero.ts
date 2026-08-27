// Shared TV home hero band: left-aligned text over a right-weighted backdrop.

import { mountCachedImage } from "@/scripts/lib/img-cache.ts"

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
}

export interface HeroHandle {
  show(item: HeroItem): void
  clear(): void
  destroy(): void
}

export function createHero(root: HTMLElement): HeroHandle {
  const section = document.createElement("section")
  section.className =
    "relative h-[38vh] min-h-[22rem] w-full shrink-0 overflow-hidden rounded-2xl tv-clip-round-2xl bg-black/40"

  const backdropWrap = document.createElement("div")
  backdropWrap.className = "absolute inset-0"

  const gradientLeft = document.createElement("div")
  gradientLeft.className = "absolute inset-0 bg-gradient-to-r from-bg via-bg/75 to-transparent"
  const gradientBottom = document.createElement("div")
  gradientBottom.className = "absolute inset-0 bg-gradient-to-t from-bg/40 via-transparent to-transparent"

  const textBlock = document.createElement("div")
  textBlock.className = "relative flex h-full max-w-2xl flex-col justify-end gap-3 p-12"

  const eyebrow = document.createElement("p")
  eyebrow.className = "text-sm font-semibold uppercase tracking-wide text-accent"
  const title = document.createElement("h1")
  title.className = "line-clamp-2 text-4xl font-semibold text-fg"
  const meta = document.createElement("p")
  meta.className = "text-base text-fg-2"

  const progressTrack = document.createElement("div")
  progressTrack.className = "mt-1 h-1.5 w-64 max-w-full overflow-hidden rounded-full bg-white/15"
  progressTrack.hidden = true
  const progressFill = document.createElement("div")
  progressFill.className = "h-full rounded-full bg-accent"
  progressTrack.appendChild(progressFill)

  let ctaEl: HTMLAnchorElement | null = null

  textBlock.append(eyebrow, title, meta, progressTrack)
  section.append(backdropWrap, gradientLeft, gradientBottom, textBlock)
  root.appendChild(section)

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
      "mt-2 inline-flex w-fit items-center gap-2 rounded-xl bg-accent px-6 py-3 text-base " +
      "font-semibold text-bg outline-none tv-focus-inset"
    ctaEl.textContent = cta.label
    textBlock.appendChild(ctaEl)
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
  }

  function clear(): void {
    eyebrow.textContent = ""
    title.textContent = ""
    meta.textContent = ""
    progressTrack.hidden = true
    backdropWrap.replaceChildren()
    setCta(undefined)
  }

  function destroy(): void {
    section.remove()
  }

  return { show, clear, destroy }
}
