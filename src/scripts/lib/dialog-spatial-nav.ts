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

    let registered = false

    const register = () => {
        const SN = window.SpatialNavigation
        if (!SN || registered) return
        // Suspend the main section *only* after a successful SN.add. If add
        // throws (duplicate id, bad selector), bail without touching the
        // refcount so the page stays navigable.
        try {
            SN.add({
                id: sectionId,
                selector,
                restrict: "self-only",
                enterTo: "default-element",
                defaultElement: opts.defaultElement || selector,
            })
        } catch {
            return
        }
        registered = true
        suspendMainSection()
        SN.makeFocusable?.()

        const active = document.activeElement
        if (!active || !dlg.contains(active)) {
            const target =
                (opts.defaultElement
                    ? document.querySelector<HTMLElement>(opts.defaultElement)
                    : null) ||
                dlg.querySelector<HTMLElement>(selector)
            target?.focus?.()
        }
    }

    const unregister = () => {
        const SN = window.SpatialNavigation
        if (!SN || !registered) return
        try {
            SN.remove(sectionId)
        } catch {}
        registered = false
        resumeMainSection()
    }

    const observer = new MutationObserver(() => {
        if (dlg.hasAttribute("open")) register()
        else unregister()
    })
    observer.observe(dlg, { attributes: true, attributeFilter: ["open"] })
    dlg.addEventListener("close", unregister)

    if (dlg.hasAttribute("open")) register()

    return () => {
        observer.disconnect()
        dlg.removeEventListener("close", unregister)
        unregister()
    }
}
