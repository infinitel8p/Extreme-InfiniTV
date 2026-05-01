// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
const ARROW_DIRECTIONS = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
}

export function attachPlayerFocusKeeper(vjs) {
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
    const onFocusOut = (e) => {
        if (!playerEl.contains(/** @type {Node|null} */ (e.relatedTarget))) {
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
    const onArrowCapture = (e) => {
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
    playerEl.addEventListener("focusout", onFocusOut)
    playerEl.addEventListener("keydown", onArrowCapture, true)
    vjs.on("fullscreenchange", onFullscreenChange)

    return () => {
        stopPulse()
        playerEl.removeEventListener("focusin", onFocusIn)
        playerEl.removeEventListener("focusout", onFocusOut)
        playerEl.removeEventListener("keydown", onArrowCapture, true)
        try { vjs.off("fullscreenchange", onFullscreenChange) } catch {}
    }
}
