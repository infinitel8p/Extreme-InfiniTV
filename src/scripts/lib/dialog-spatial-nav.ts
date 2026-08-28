const DEFAULT_FOCUSABLES =
    "button, a, [role='tab'], [tabindex]:not([tabindex='-1']), input, select, textarea, summary"

const MAIN_SECTION_ID = "main"

let mainDisabledDepth = 0
function suspendMainSection() {
    if (mainDisabledDepth === 0) {
        try { window.SpatialNavigation?.disable?.(MAIN_SECTION_ID) } catch {}
    }
    mainDisabledDepth++
}
function resumeMainSection() {
    if (mainDisabledDepth === 0) return
    mainDisabledDepth--
    if (mainDisabledDepth === 0) {
        try { window.SpatialNavigation?.enable?.(MAIN_SECTION_ID) } catch {}
    }
}

interface SectionOpts {
    id: string
    selector: string
    defaultElement?: string
    focusOnRegister?: HTMLElement | null
}

// Shared registration core used by both <dialog> and popover wrappers.
// Returns register/unregister handles plus the refcount-safe main-section
// suspend that all overlay surfaces want.
function makeSectionHandle(opts: SectionOpts) {
    let registered = false

    const register = () => {
        const SN = window.SpatialNavigation
        if (!SN || registered) return
        // A body swap can destroy an open dialog without firing its close event, leaking the section id.
        try { SN.remove(opts.id) } catch {}
        try {
            SN.add({
                id: opts.id,
                selector: opts.selector,
                restrict: "self-only",
                enterTo: "default-element",
                defaultElement: opts.defaultElement || opts.selector,
            })
        } catch {
            return
        }
        registered = true
        suspendMainSection()
        SN.makeFocusable?.()
    }

    const unregister = () => {
        const SN = window.SpatialNavigation
        if (!SN || !registered) return
        try {
            SN.remove(opts.id)
        } catch {}
        registered = false
        resumeMainSection()
    }

    return { register, unregister }
}

interface AttachOpts {
    id?: string
    selector?: string
    defaultElement?: string
}

export function attachDialogSpatialNav(
    dlg: HTMLDialogElement | null,
    opts: AttachOpts = {}
): (() => void) | undefined {
    if (!dlg || !dlg.id) return

    const sectionId = opts.id || `${dlg.id}-section`
    const selector =
        opts.selector ||
        DEFAULT_FOCUSABLES.split(",")
            .map((s) => `#${dlg.id} ${s.trim()}`)
            .join(", ")

    const { register, unregister } = makeSectionHandle({
        id: sectionId,
        selector,
        defaultElement: opts.defaultElement,
    })

    const registerWithFocus = () => {
        register()
        const active = document.activeElement
        if (!active || !dlg.contains(active)) {
            const target =
                (opts.defaultElement
                    ? document.querySelector<HTMLElement>(opts.defaultElement)
                    : null) ||
                dlg.querySelector<HTMLElement>(selector)
            target?.focus?.({ focusVisible: true })
        }
    }

    const observer = new MutationObserver(() => {
        if (dlg.hasAttribute("open")) registerWithFocus()
        else unregister()
    })
    observer.observe(dlg, { attributes: true, attributeFilter: ["open"] })
    dlg.addEventListener("close", unregister)
    // A page swap while the dialog is open never fires "close"; unregister explicitly.
    document.addEventListener("astro:before-swap", unregister)

    if (dlg.hasAttribute("open")) registerWithFocus()

    return () => {
        observer.disconnect()
        dlg.removeEventListener("close", unregister)
        document.removeEventListener("astro:before-swap", unregister)
        unregister()
    }
}

interface PopoverOpts {
    /** Spatial-nav section id. Required - no element id to derive from. */
    id: string
    /** CSS selector for focusable items inside the popover. */
    selector: string
    /** Optional default element selector for enterTo. */
    defaultElement?: string
}

interface PopoverHandle {
    /** Call when the popover becomes visible. */
    open: () => void
    /** Call when the popover hides. Safe to call repeatedly. */
    close: () => void
    /** Same as close - call on component unmount. */
    teardown: () => void
}

/**
 * Spatial-nav wrapper for non-<dialog> popovers / floating menus. Mirrors
 * attachDialogSpatialNav: registers a self-only section, suspends the
 * shared "main" section via the same refcount, and exposes explicit
 * open/close calls (since plain elements don't have a standard "open"
 * attribute or close event we can observe).
 */
export function attachPopoverSpatialNav(opts: PopoverOpts): PopoverHandle {
    const { register, unregister } = makeSectionHandle({
        id: opts.id,
        selector: opts.selector,
        defaultElement: opts.defaultElement,
    })
    return {
        open: register,
        close: unregister,
        teardown: unregister,
    }
}
