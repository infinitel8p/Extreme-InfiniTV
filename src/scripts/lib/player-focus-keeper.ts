const ARROW_DIRECTIONS: Record<string, string> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
}

// Minimal Video.js shape we touch. Loose to avoid pulling @types/video.js.
interface VjsLike {
    el(): HTMLElement
    userActive(active: boolean): void
    on(event: string, fn: () => void): void
    off(event: string, fn: () => void): void
}

export function attachPlayerFocusKeeper(vjs: VjsLike | null | undefined): () => void {
    if (!vjs) return () => {}
    const playerEl = vjs.el()
    let pulse = 0

    const stopPulse = () => {
        if (pulse) {
            clearInterval(pulse)
            pulse = 0
        }
    }
    const onFocusIn = () => {
        vjs.userActive(true)
        window.SpatialNavigation?.makeFocusable?.()
        stopPulse()
        pulse = window.setInterval(() => vjs.userActive(true), 1500)
    }
    const onFocusOut = (e: FocusEvent) => {
        if (!playerEl.contains(e.relatedTarget as Node | null)) {
            stopPulse()
        }
    }
    const onFullscreenChange = () => {
        window.SpatialNavigation?.makeFocusable?.()
        vjs.userActive(true)
    }

    // Video.js stopPropagation()s every non-Tab keydown, so the spatial-nav
    // polyfill's window-level listener never sees arrows once focus is in
    // the player. Capture phase runs before video.js gets the event.
    const onArrowCapture = (e: KeyboardEvent) => {
        const dir = ARROW_DIRECTIONS[e.key]
        if (!dir) return
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
        const SN = window.SpatialNavigation
        if (!SN) return
        SN.makeFocusable?.()
        const moved = SN.move?.(dir)
        if (moved) {
            e.stopImmediatePropagation()
            e.preventDefault()
        }
    }

    playerEl.addEventListener("focusin", onFocusIn)
    playerEl.addEventListener("focusout", onFocusOut as EventListener)
    playerEl.addEventListener("keydown", onArrowCapture as EventListener, true)
    vjs.on("fullscreenchange", onFullscreenChange)

    return () => {
        stopPulse()
        playerEl.removeEventListener("focusin", onFocusIn)
        playerEl.removeEventListener("focusout", onFocusOut as EventListener)
        playerEl.removeEventListener("keydown", onArrowCapture as EventListener, true)
        try { vjs.off("fullscreenchange", onFullscreenChange) } catch {}
    }
}
