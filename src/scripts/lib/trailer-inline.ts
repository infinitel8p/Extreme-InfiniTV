// Inline YouTube trailer embed swapped into the detail-page hero.

import { youtubeKeyFromUrl } from "@/scripts/lib/detail-chrome.ts"
import { openExternal } from "@/scripts/lib/external-link.js"
import { t } from "@/scripts/lib/i18n.js"
import { toast } from "@/scripts/lib/toast.js"

export interface InlineTrailerOptions {
  wrapEl: HTMLElement | null
  frameEl: HTMLIFrameElement | null
  closeBtn: HTMLElement | null
  externalBtn: HTMLElement | null
  posterEl: HTMLElement | null
  playerWrap: HTMLElement | null
  onOpen?: () => void
  onStateChange?: (open: boolean) => void
}

export interface InlineTrailerController {
  open(youtubeUrl: string, title?: string): void
  close(): void
  isOpen(): boolean
}

export function createInlineTrailer(options: InlineTrailerOptions): InlineTrailerController {
  const { wrapEl, frameEl, closeBtn, externalBtn, posterEl, playerWrap } = options

  let currentUrl = ""
  let isOpen = false
  let restoreEl: HTMLElement | null = null
  let previousFocus: HTMLElement | null = null

  function embedSrc(key: string): string {
    return `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&rel=0&enablejsapi=1`
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") closeTrailer()
  }

  function handleFrameMessage(event: MessageEvent): void {
    if (!isOpen || !frameEl || event.source !== frameEl.contentWindow) return
    let payload: unknown
    try {
      payload = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (!payload || typeof payload !== "object") return
    if ((payload as { event?: string }).event !== "onError") return

    closeTrailer()
    openExternal(currentUrl)
    toast({ title: t("detail.trailer.embedBlocked"), duration: 2600 })
  }

  function handleFrameLoad(): void {
    if (!frameEl || !frameEl.src) return
    wrapEl?.classList.remove("skel")
    frameEl.contentWindow?.postMessage(
      JSON.stringify({ event: "listening", id: "xt-trailer", channel: "widget" }),
      "*"
    )
  }

  if (typeof document !== "undefined") {
    window.addEventListener("message", handleFrameMessage)
    frameEl?.addEventListener("load", handleFrameLoad)
  }

  closeBtn?.addEventListener("click", () => closeTrailer())
  externalBtn?.addEventListener("click", () => {
    openExternal(currentUrl)
    closeTrailer()
  })

  function openTrailer(youtubeUrl: string, title?: string): void {
    if (typeof document === "undefined") return
    const key = youtubeKeyFromUrl(youtubeUrl)
    if (!key) {
      openExternal(youtubeUrl)
      return
    }

    currentUrl = youtubeUrl
    const trailerTitle = title || t("detail.action.trailer")

    if (isOpen) {
      if (frameEl) {
        frameEl.title = trailerTitle
        frameEl.src = embedSrc(key)
      }
      return
    }

    options.onOpen?.()

    restoreEl = posterEl && !posterEl.classList.contains("hidden")
      ? posterEl
      : playerWrap && !playerWrap.classList.contains("hidden")
        ? playerWrap
        : null
    posterEl?.classList.add("hidden")
    playerWrap?.classList.add("hidden")
    wrapEl?.classList.remove("hidden")
    wrapEl?.classList.add("skel")

    if (frameEl) {
      frameEl.title = trailerTitle
      frameEl.src = embedSrc(key)
    }

    isOpen = true
    previousFocus = document.activeElement as HTMLElement | null
    document.addEventListener("keydown", handleKeydown)
    wrapEl?.scrollIntoView({ block: "nearest" })
    requestAnimationFrame(() => closeBtn?.focus?.({ preventScroll: true }))
    options.onStateChange?.(true)
  }

  function closeTrailer(): void {
    if (!isOpen) return
    isOpen = false
    document.removeEventListener("keydown", handleKeydown)
    if (frameEl) frameEl.src = ""
    wrapEl?.classList.add("hidden")
    wrapEl?.classList.remove("skel")
    restoreEl?.classList.remove("hidden")
    restoreEl = null
    const activeEl = document.activeElement
    const focusInsideWrap = !!wrapEl && !!activeEl && wrapEl.contains(activeEl)
    const focusLost = !activeEl || activeEl === document.body
    if ((focusInsideWrap || focusLost) && previousFocus && previousFocus.isConnected) previousFocus.focus?.()
    previousFocus = null
    options.onStateChange?.(false)
  }

  return {
    open: openTrailer,
    close: closeTrailer,
    isOpen: () => isOpen,
  }
}
