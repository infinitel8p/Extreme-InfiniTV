// @ts-nocheck - migrated to TS shell; strict typing pending follow-up
// Behavior for [data-sort-menu] components: toggles a styled listbox panel
// over a hidden native <select>, so existing code that reads/writes the
// select's `.value` keeps working unchanged.

const initialised = new WeakSet()

function initSortMenu(wrapper) {
    if (initialised.has(wrapper)) return
    initialised.add(wrapper)

    const select = /** @type {HTMLSelectElement|null} */ (
        wrapper.querySelector("[data-sort-menu-select]")
    )
    const button = /** @type {HTMLButtonElement|null} */ (
        wrapper.querySelector("[data-sort-menu-button]")
    )
    const panel = /** @type {HTMLElement|null} */ (
        wrapper.querySelector("[data-sort-menu-panel]")
    )
    const valueLabel = /** @type {HTMLElement|null} */ (
        wrapper.querySelector("[data-sort-menu-value]")
    )
    if (!select || !button || !panel || !valueLabel) return

    const options = /** @type {HTMLButtonElement[]} */ (
        Array.from(panel.querySelectorAll("[role='option']"))
    )

    function syncFromSelect() {
        const current = select.value
        let activeLabel = ""
        for (const option of options) {
            const matched = option.dataset.value === current
            option.setAttribute("aria-selected", matched ? "true" : "false")
            if (matched) activeLabel = option.querySelector("span")?.textContent || ""
        }
        if (!activeLabel) {
            const native = select.options[select.selectedIndex]
            activeLabel = native?.textContent?.trim() || ""
        }
        valueLabel.textContent = activeLabel
    }

    function isOpen() {
        return button.getAttribute("aria-expanded") === "true"
    }

    function open() {
        if (isOpen()) return
        closeAllExcept(wrapper)
        button.setAttribute("aria-expanded", "true")
        panel.hidden = false
        // Prefer the currently-selected option, fall back to first.
        const target =
            options.find((opt) => opt.getAttribute("aria-selected") === "true") ||
            options[0]
        // Defer focus so the panel is laid out before spatial-nav considers it.
        requestAnimationFrame(() => {
            target?.focus()
            window.SpatialNavigation?.makeFocusable?.()
        })
    }

    function close({ restoreFocus = true } = {}) {
        if (!isOpen()) return
        button.setAttribute("aria-expanded", "false")
        panel.hidden = true
        if (restoreFocus) button.focus()
    }

    function selectValue(value) {
        if (select.value === value) {
            syncFromSelect()
            return
        }
        select.value = value
        select.dispatchEvent(new Event("change", { bubbles: true }))
        syncFromSelect()
    }

    button.addEventListener("click", () => {
        if (isOpen()) close()
        else open()
    })

    button.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            event.stopPropagation()
            open()
        }
    })

    for (const option of options) {
        option.addEventListener("click", () => {
            const value = option.dataset.value || ""
            selectValue(value)
            close()
        })
    }

    panel.addEventListener("keydown", (event) => {
        const focusables = options
        const currentIndex = focusables.indexOf(
            /** @type {HTMLButtonElement} */ (document.activeElement),
        )
        const handled = () => {
            event.preventDefault()
            event.stopPropagation()
        }
        switch (event.key) {
            case "Escape":
                handled()
                close()
                break
            case "Tab":
                close({ restoreFocus: false })
                break
            case "ArrowDown": {
                handled()
                const next = focusables[(currentIndex + 1) % focusables.length]
                next?.focus()
                break
            }
            case "ArrowUp": {
                handled()
                const prev =
                    focusables[
                        (currentIndex - 1 + focusables.length) %
                            focusables.length
                    ]
                prev?.focus()
                break
            }
            case "ArrowLeft":
            case "ArrowRight":
                handled()
                close()
                break
            case "Home": {
                handled()
                focusables[0]?.focus()
                break
            }
            case "End": {
                handled()
                focusables[focusables.length - 1]?.focus()
                break
            }
            case "Enter":
            case " ": {
                handled()
                const current = focusables[currentIndex]
                if (current) {
                    const value = current.dataset.value || ""
                    selectValue(value)
                    close()
                }
                break
            }
            default:
                break
        }
    })

    // Click outside closes (use mousedown so we beat focus moves).
    document.addEventListener("mousedown", (event) => {
        if (!isOpen()) return
        if (wrapper.contains(/** @type {Node} */ (event.target))) return
        close({ restoreFocus: false })
    })

    document.addEventListener("focusin", (event) => {
        if (!isOpen()) return
        if (wrapper.contains(/** @type {Node} */ (event.target))) return
        close({ restoreFocus: false })
    })

    // Programmatic `select.value = ...` doesn't fire `change`, so patch the
    // accessor on this instance and call syncFromSelect from the setter.
    const valueDescriptor = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
    )
    if (valueDescriptor?.get && valueDescriptor.set) {
        Object.defineProperty(select, "value", {
            configurable: true,
            get() {
                return valueDescriptor.get.call(this)
            },
            set(next) {
                valueDescriptor.set.call(this, next)
                syncFromSelect()
            },
        })
    }

    syncFromSelect()
}

function closeAllExcept(except) {
    const wrappers = document.querySelectorAll("[data-sort-menu]")
    for (const wrapper of wrappers) {
        if (wrapper === except) continue
        const button = wrapper.querySelector("[data-sort-menu-button]")
        const panel = wrapper.querySelector("[data-sort-menu-panel]")
        if (button?.getAttribute("aria-expanded") === "true") {
            button.setAttribute("aria-expanded", "false")
            if (panel) panel.hidden = true
        }
    }
}

function initAll() {
    const wrappers = document.querySelectorAll("[data-sort-menu]")
    for (const wrapper of wrappers) initSortMenu(wrapper)
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll, { once: true })
} else {
    initAll()
}
