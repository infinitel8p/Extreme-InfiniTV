// Shared TV home hero band: left-aligned text over a right-weighted backdrop.

import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { registerFocusSection } from "@/scripts/tv/focus"
import { motionAllowed, TV_EASE, effectTier, heavyEffectsAllowed, memoryConservative } from "@/scripts/tv/motion"
import { applyAmbient, clearAmbient } from "@/scripts/tv/ambient-color"

const HERO_FOCUS_SECTION_ID = "tv-home-hero"
export const HERO_FOCUS_KEY = "hero"

const BACKDROP_CROSSFADE_MS = 480
const BACKDROP_CROSSFADE_MS_LITE = 240
const IMAGE_READY_TIMEOUT_MS = 300
const KEN_BURNS_MS = 16000
const TEXT_DIP_MS = 160
const TEXT_SWAP_TROUGH_MS = 120

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
  imageKind?: "poster" | "logo" | "backdrop" | "banner"
  cta?: HeroCta
  /** Enter/OK on the hero itself when there's no `cta` (poster items navigate, live items tune in). */
  onActivate?: () => void
  /** Accessible name for the activation button; falls back to `title` when absent. */
  ariaLabel?: string
}

export interface HeroHandle {
  show(item: HeroItem): void
  clear(): void
  destroy(): void
}

/** Resolves once the image has a decoded frame ready, or after a timeout - never rejects. */
export function waitForImageReady(img: HTMLImageElement, options?: { skipDecode?: boolean }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const timer = setTimeout(finish, IMAGE_READY_TIMEOUT_MS)
    const decodeThenFinish = () => {
      clearTimeout(timer)
      // Lite waits for load only - decode() forces a full-size bitmap decode right away.
      if (!options?.skipDecode && typeof img.decode === "function") img.decode().then(finish).catch(finish)
      else finish()
    }
    if (img.complete && img.naturalWidth > 0) {
      decodeThenFinish()
      return
    }
    img.addEventListener("load", decodeThenFinish, { once: true })
    img.addEventListener("error", finish, { once: true })
  })
}

export function backdropKeyFor(imageUrl: string | null | undefined, imageKind: string | undefined): string {
  return imageUrl ? `${imageKind || "backdrop"}:${imageUrl}` : ""
}

export function textSignatureFor(item: HeroItem): string {
  return `${item.eyebrow} ${item.title} ${item.meta} ${item.progressPercent ?? ""}`
}

export function createHero(root: HTMLElement): HeroHandle {
  const section = document.createElement("section")
  section.className =
    "relative isolate h-[40vh] min-h-[13rem] w-full shrink-0 overflow-hidden rounded-2xl bg-black/40 tv-edge-mask"

  const backdropWrap = document.createElement("div")
  backdropWrap.className = "absolute inset-0"

  const gradientLeft = document.createElement("div")
  gradientLeft.className = "absolute inset-0"
  // Tint blends into an opaque bg first, so the alpha ramp matches the pre-ambient gradient exactly.
  gradientLeft.style.backgroundImage =
    "linear-gradient(to right, var(--color-bg), " +
    "color-mix(in oklab, color-mix(in oklab, var(--color-bg), var(--tv-ambient, var(--color-bg)) 20%) 75%, transparent), " +
    "transparent)"
  const gradientBottom = document.createElement("div")
  gradientBottom.className = "absolute inset-0"
  gradientBottom.style.backgroundImage =
    "linear-gradient(to top, color-mix(in oklab, var(--color-bg) 40%, transparent), var(--tv-ambient-soft, transparent), transparent)"

  const textBlock = document.createElement("div")
  textBlock.className = "relative flex h-full max-w-xl flex-col justify-end gap-2 p-6"

  const eyebrow = document.createElement("p")
  eyebrow.className = "min-h-4 text-xs font-semibold uppercase tracking-wide text-accent"
  const title = document.createElement("h1")
  title.className = "line-clamp-2 min-h-[4.5rem] text-3xl font-semibold text-fg"
  const meta = document.createElement("p")
  meta.className = "min-h-5 text-sm text-fg-2"

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

  let currentBackdropKey = ""
  let backdropGeneration = 0
  let currentTextSignature = ""
  let textSwapAnimation: Animation | null = null
  let textSwapTimerId = 0
  const kenBurnsByLayer = new Map<HTMLElement, Animation>()

  function startKenBurns(img: HTMLImageElement, layer: HTMLElement): void {
    if (!heavyEffectsAllowed()) return
    const animation = img.animate(
      [
        { transform: "scale(1) translate(0, 0)" },
        { transform: "scale(1.06) translate(-1.5%, -1%)" },
      ],
      { duration: KEN_BURNS_MS, easing: "linear", fill: "forwards" }
    )
    kenBurnsByLayer.set(layer, animation)
  }

  function removeLayer(layer: HTMLElement): void {
    kenBurnsByLayer.get(layer)?.cancel()
    kenBurnsByLayer.delete(layer)
    // Frees the decoded bitmap immediately instead of waiting for GC to notice a detached img.
    for (const img of Array.from(layer.querySelectorAll("img"))) {
      img.removeAttribute("src")
      img.removeAttribute("srcset")
      delete img.dataset.backdropUrl
    }
    layer.remove()
  }

  function buildBackdropLayer(
    imageUrl: string,
    imageKind: "poster" | "logo" | "backdrop" | "banner" | undefined
  ): { layer: HTMLDivElement; images: HTMLImageElement[]; realBackdropImg: HTMLImageElement | null } {
    const layer = document.createElement("div")
    layer.className = "absolute inset-0"
    layer.style.opacity = "0"

    if (imageKind === "banner") {
      const images: HTMLImageElement[] = []
      if (effectTier() === "full") {
        const blurred = document.createElement("img")
        blurred.alt = ""
        blurred.setAttribute("aria-hidden", "true")
        blurred.loading = "lazy"
        blurred.decoding = "async"
        blurred.dataset.backdropUrl = imageUrl
        blurred.className = "absolute inset-0 h-full w-full scale-125 object-cover opacity-40 blur-3xl saturate-150"
        layer.appendChild(blurred)
        mountCachedImage(blurred, imageUrl, "backdrop")
        images.push(blurred)
      } else {
        const flat = document.createElement("div")
        flat.className = "absolute inset-0 bg-surface-2"
        layer.appendChild(flat)
      }

      const contained = document.createElement("img")
      contained.alt = ""
      contained.loading = "lazy"
      contained.decoding = "async"
      contained.dataset.backdropUrl = imageUrl
      contained.className = "absolute right-0 top-1/2 max-h-[70%] max-w-[60%] -translate-y-1/2 object-contain"
      layer.appendChild(contained)
      mountCachedImage(contained, imageUrl, "backdrop")
      images.push(contained)
      // No Ken Burns on banners: realBackdropImg stays null.
      return { layer, images, realBackdropImg: null }
    }

    if (imageKind === "logo") {
      const images: HTMLImageElement[] = []
      if (effectTier() === "full") {
        const blurred = document.createElement("img")
        blurred.alt = ""
        blurred.setAttribute("aria-hidden", "true")
        blurred.loading = "lazy"
        blurred.decoding = "async"
        blurred.dataset.backdropUrl = imageUrl
        blurred.className = "absolute inset-0 h-full w-full scale-125 object-cover opacity-40 blur-3xl saturate-150"
        layer.appendChild(blurred)
        // "logo" cache class (128px) stretched full-band looked blocky; blur hides "poster"'s softness fine.
        mountCachedImage(blurred, imageUrl, "poster")
        images.push(blurred)
      } else {
        // Full-bleed blur of a large image is the single most expensive layer here.
        const flat = document.createElement("div")
        flat.className = "absolute inset-0 bg-surface-2"
        layer.appendChild(flat)
      }

      const contained = document.createElement("img")
      contained.alt = ""
      contained.loading = "lazy"
      contained.decoding = "async"
      contained.dataset.backdropUrl = imageUrl
      contained.className = "absolute right-[6%] top-1/2 max-h-[55%] max-w-[42%] -translate-y-1/2 object-contain"
      layer.appendChild(contained)
      mountCachedImage(contained, imageUrl, "logo")
      images.push(contained)
      return { layer, images, realBackdropImg: null }
    }

    // Real backdrop art is a landscape source; caching it at the poster's 576px cap
    // would blur it stretched across the full-width band.
    const img = document.createElement("img")
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    img.dataset.backdropUrl = imageUrl
    img.className = "absolute inset-0 h-full w-full object-cover"
    layer.appendChild(img)
    mountCachedImage(img, imageUrl, imageKind === "backdrop" ? "backdrop" : "poster")
    return { layer, images: [img], realBackdropImg: img }
  }

  function setBackdrop(
    imageUrl: string | null | undefined,
    imageKind: "poster" | "logo" | "backdrop" | "banner" | undefined
  ): void {
    const key = backdropKeyFor(imageUrl, imageKind)
    if (key === currentBackdropKey) return
    currentBackdropKey = key
    const generation = ++backdropGeneration

    if (!imageUrl) {
      for (const layer of Array.from(backdropWrap.children) as HTMLElement[]) removeLayer(layer)
      clearAmbient(section)
      return
    }
    void applyAmbient(section, imageUrl, {
      kind: imageKind === "backdrop" || imageKind === "banner" ? "backdrop" : "poster",
    })

    if (!motionAllowed()) {
      for (const layer of Array.from(backdropWrap.children) as HTMLElement[]) removeLayer(layer)
      const { layer } = buildBackdropLayer(imageUrl, imageKind)
      layer.style.opacity = "1"
      backdropWrap.appendChild(layer)
      return
    }

    const { layer, images, realBackdropImg } = buildBackdropLayer(imageUrl, imageKind)
    backdropWrap.appendChild(layer)
    const previousLayers = (Array.from(backdropWrap.children) as HTMLElement[]).filter((child) => child !== layer)

    const skipDecode = memoryConservative()
    void Promise.all(images.map((backdropImg) => waitForImageReady(backdropImg, { skipDecode }))).then(() => {
      if (generation !== backdropGeneration) {
        removeLayer(layer)
        return
      }
      const lite = effectTier() !== "full"
      const duration = lite ? BACKDROP_CROSSFADE_MS_LITE : BACKDROP_CROSSFADE_MS
      const fadeIn = layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: TV_EASE, fill: "forwards" })
      if (realBackdropImg) startKenBurns(realBackdropImg, layer)
      if (lite) {
        // Drops the outgoing layer as soon as the new one is visible instead of
        // running its own fade-out, so the two layers overlap for less time.
        fadeIn.onfinish = () => {
          for (const previousLayer of previousLayers) removeLayer(previousLayer)
        }
      } else {
        for (const previousLayer of previousLayers) {
          const fadeOut = previousLayer.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration,
            easing: TV_EASE,
            fill: "forwards",
          })
          fadeOut.onfinish = () => removeLayer(previousLayer)
        }
      }
    })
  }

  function applyTextContent(item: HeroItem): void {
    eyebrow.textContent = item.eyebrow
    title.textContent = item.title
    meta.textContent = item.meta
    if (item.progressPercent != null && item.progressPercent > 0) {
      progressTrack.hidden = false
      progressFill.style.width = `${Math.max(0, Math.min(100, item.progressPercent))}%`
    } else {
      progressTrack.hidden = true
    }
  }

  function setText(item: HeroItem): void {
    const signature = textSignatureFor(item)
    if (signature === currentTextSignature) return
    currentTextSignature = signature

    if (!motionAllowed()) {
      applyTextContent(item)
      return
    }

    const startOpacity = getComputedStyle(textBlock).opacity || "1"
    textSwapAnimation?.cancel()
    window.clearTimeout(textSwapTimerId)
    const dipOut = textBlock.animate([{ opacity: startOpacity }, { opacity: 0 }], {
      duration: TEXT_DIP_MS,
      easing: "ease-out",
      fill: "forwards",
    })
    textSwapAnimation = dipOut
    // Swap at the trough, independent of the dip animation's own finish event.
    textSwapTimerId = window.setTimeout(() => applyTextContent(item), TEXT_SWAP_TROUGH_MS)
    dipOut.onfinish = () => {
      textSwapAnimation = textBlock.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: TEXT_DIP_MS,
        easing: "ease-in",
        fill: "forwards",
      })
    }
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
    activateButton.setAttribute("aria-label", item.ariaLabel || item.title)
    activateButton.onclick = () => onActivate()
  }

  function show(item: HeroItem): void {
    setText(item)
    setBackdrop(item.imageUrl, item.imageKind)
    setCta(item.cta)
    setActivate(item)
  }

  function clear(): void {
    textSwapAnimation?.cancel()
    textSwapAnimation = null
    window.clearTimeout(textSwapTimerId)
    currentTextSignature = ""
    eyebrow.textContent = ""
    title.textContent = ""
    meta.textContent = ""
    progressTrack.hidden = true
    backdropGeneration++
    currentBackdropKey = ""
    for (const layer of Array.from(backdropWrap.children) as HTMLElement[]) removeLayer(layer)
    clearAmbient(section)
    setCta(undefined)
    activateButton.hidden = true
    activateButton.onclick = null
  }

  function destroy(): void {
    // Backdrops are the largest bitmaps on screen; drop them now instead of waiting for GC.
    clear()
    unregisterHeroSection()
    section.remove()
  }

  return { show, clear, destroy }
}
