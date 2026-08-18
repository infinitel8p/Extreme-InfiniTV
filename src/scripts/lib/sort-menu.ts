// Behavior for [data-sort-menu] components: toggles a styled listbox panel
// over a hidden native <select>, so existing code that reads/writes the
// select's `.value` keeps working unchanged.

const initialised = new WeakSet<Element>()

// Fired to rebuild a secondary select's menu items after its <option>s are repopulated.
const SECONDARY_REFRESH_EVENT = "xt:sort-menu-refresh"

const CHECK_SVG =
    '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" class="text-accent shrink-0 sort-menu__check"><path d="M5 12l5 5L20 7" /></svg>'

function buildSecondaryOptionButton(option: HTMLOptionElement, hasToggles: boolean): HTMLButtonElement {
    const button = document.createElement("button")
    button.type = "button"
    button.setAttribute("role", hasToggles ? "menuitemradio" : "option")
    button.dataset.value = option.value
    button.setAttribute("aria-selected", option.selected ? "true" : "false")
    if (hasToggles) button.setAttribute("aria-checked", option.selected ? "true" : "false")
    button.className =
        "sort-menu__option w-full text-left rounded-lg px-3 py-2 text-sm " +
        "flex items-center justify-between gap-3 " +
        "text-fg-2 hover:text-fg hover:bg-surface-2 " +
        "focus-visible:bg-surface-2 focus-visible:text-fg focus-visible:outline-none " +
        "aria-selected:text-fg aria-selected:bg-accent-soft transition-colors"
    const label = document.createElement("span")
    label.className = "truncate"
    label.textContent = option.textContent || option.value
    button.appendChild(label)
    button.insertAdjacentHTML("beforeend", CHECK_SVG)
    return button
}

function initSortMenu(wrapper: Element) {
    if (initialised.has(wrapper)) return
    initialised.add(wrapper)

    const selectMaybe = wrapper.querySelector<HTMLSelectElement>("[data-sort-menu-select]")
    const buttonMaybe = wrapper.querySelector<HTMLButtonElement>("[data-sort-menu-button]")
    const panelMaybe = wrapper.querySelector<HTMLElement>("[data-sort-menu-panel]")
    const valueLabelMaybe = wrapper.querySelector<HTMLElement>("[data-sort-menu-value]")
    if (!selectMaybe || !buttonMaybe || !panelMaybe || !valueLabelMaybe) return
    // Bind to non-nullable locals so closures don't have to re-narrow.
    const select = selectMaybe
    const button = buttonMaybe
    const panel = panelMaybe
    const valueLabel = valueLabelMaybe

    const options = Array.from(
        panel.querySelectorAll<HTMLButtonElement>("[role='option'], [role='menuitemradio']")
    )
    const toggles = Array.from(
        panel.querySelectorAll<HTMLButtonElement>("[data-sort-menu-toggle]")
    )
    const secondarySelects = Array.from(
        wrapper.querySelectorAll<HTMLSelectElement>("[data-sort-menu-select-secondary]")
    )

    // Recomputed each pass since secondary select options and hidden sections can change at runtime.
    function collectFocusables(): HTMLButtonElement[] {
        return Array.from(
            panel.querySelectorAll<HTMLButtonElement>(
                "[role='option'], [role='menuitemradio'], [data-sort-menu-toggle]"
            )
        ).filter((element) => !element.closest("[hidden]"))
    }

    function syncFromSelect() {
        const current = select.value
        let activeLabel = ""
        for (const option of options) {
            const matched = option.dataset.value === current
            option.setAttribute("aria-selected", matched ? "true" : "false")
            if (option.hasAttribute("aria-checked")) {
                option.setAttribute("aria-checked", matched ? "true" : "false")
            }
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
        const currentFocusables = collectFocusables()
        const target =
            currentFocusables.find((opt) => opt.getAttribute("aria-selected") === "true") ||
            currentFocusables[0]
        // Defer focus so the panel is laid out before spatial-nav considers it.
        requestAnimationFrame(() => {
            target?.focus()
            window.SpatialNavigation?.makeFocusable?.()
        })
    }

    function close({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
        if (!isOpen()) return
        button.setAttribute("aria-expanded", "false")
        panel.hidden = true
        if (restoreFocus) button.focus()
    }

    function selectValue(value: string) {
        if (select.value === value) {
            syncFromSelect()
            return
        }
        select.value = value
        select.dispatchEvent(new Event("change", { bubbles: true }))
        syncFromSelect()
    }

    function selectSecondaryValue(secondarySelect: HTMLSelectElement, value: string) {
        if (secondarySelect.value === value) return
        secondarySelect.value = value
        secondarySelect.dispatchEvent(new Event("change", { bubbles: true }))
    }

    function setupSecondarySelect(secondarySelect: HTMLSelectElement) {
        const section = wrapper.querySelector<HTMLElement>(
            `[data-sort-menu-secondary-section="${secondarySelect.id}"]`
        )
        const optionsContainer = wrapper.querySelector<HTMLElement>(
            `[data-sort-menu-secondary-options="${secondarySelect.id}"]`
        )
        if (!section || !optionsContainer) return

        function syncFromSecondarySelect() {
            const current = secondarySelect.value
            for (const optionButton of Array.from(optionsContainer.children) as HTMLButtonElement[]) {
                const matched = optionButton.dataset.value === current
                optionButton.setAttribute("aria-selected", matched ? "true" : "false")
                if (optionButton.hasAttribute("aria-checked")) {
                    optionButton.setAttribute("aria-checked", matched ? "true" : "false")
                }
            }
        }

        function rebuildSecondaryOptions() {
            optionsContainer.replaceChildren()
            for (const option of Array.from(secondarySelect.options)) {
                const optionButton = buildSecondaryOptionButton(option, toggles.length > 0)
                optionButton.addEventListener("click", () => {
                    selectSecondaryValue(secondarySelect, optionButton.dataset.value || "")
                    close()
                })
                optionsContainer.appendChild(optionButton)
            }
            section.hidden = secondarySelect.options.length <= 1
            syncFromSecondarySelect()
        }

        secondarySelect.addEventListener(SECONDARY_REFRESH_EVENT, rebuildSecondaryOptions)

        // Programmatic `.value = ...` doesn't fire `change`, so patch the accessor to stay in sync.
        const secondaryValueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")
        if (secondaryValueDescriptor?.get && secondaryValueDescriptor.set) {
            const get = secondaryValueDescriptor.get
            const set = secondaryValueDescriptor.set
            Object.defineProperty(secondarySelect, "value", {
                configurable: true,
                get(this: HTMLSelectElement) {
                    return get.call(this)
                },
                set(this: HTMLSelectElement, next: string) {
                    set.call(this, next)
                    syncFromSecondarySelect()
                },
            })
        }

        rebuildSecondaryOptions()
    }

    function syncTogglesActive() {
        const anyChecked = toggles.some(
            (toggle) => toggle.getAttribute("aria-checked") === "true"
        )
        wrapper.setAttribute("data-toggles-active", String(anyChecked))
    }

    function toggleChecked(toggle: HTMLButtonElement) {
        const next = toggle.getAttribute("aria-checked") !== "true"
        toggle.setAttribute("aria-checked", String(next))
        syncTogglesActive()
    }

    function activate(target: HTMLButtonElement | undefined) {
        if (!target) return
        if (target.hasAttribute("data-sort-menu-toggle")) {
            // Real click: document-level listeners must fire too
            target.click()
            return
        }
        const secondaryContainer = target.closest<HTMLElement>("[data-sort-menu-secondary-options]")
        if (secondaryContainer) {
            const secondarySelectId = secondaryContainer.dataset.sortMenuSecondaryOptions
            const secondarySelect = secondarySelects.find((select) => select.id === secondarySelectId)
            if (secondarySelect) selectSecondaryValue(secondarySelect, target.dataset.value || "")
            close()
            return
        }
        selectValue(target.dataset.value || "")
        close()
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

    for (const toggle of toggles) {
        toggle.addEventListener("click", () => toggleChecked(toggle))
    }

    panel.addEventListener("keydown", (event) => {
        const focusables = collectFocusables()
        const currentIndex = focusables.indexOf(
            document.activeElement as HTMLButtonElement
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
                activate(focusables[currentIndex])
                break
            }
            default:
                break
        }
    })

    // Click outside closes (use mousedown so we beat focus moves).
    document.addEventListener("mousedown", (event) => {
        if (!isOpen()) return
        if (wrapper.contains(event.target as Node)) return
        close({ restoreFocus: false })
    })

    document.addEventListener("focusin", (event) => {
        if (!isOpen()) return
        if (wrapper.contains(event.target as Node)) return
        close({ restoreFocus: false })
    })

    // Programmatic `select.value = ...` doesn't fire `change`, so patch the
    // accessor on this instance and call syncFromSelect from the setter.
    const valueDescriptor = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
    )
    if (valueDescriptor?.get && valueDescriptor.set) {
        const get = valueDescriptor.get
        const set = valueDescriptor.set
        Object.defineProperty(select, "value", {
            configurable: true,
            get(this: HTMLSelectElement) {
                return get.call(this)
            },
            set(this: HTMLSelectElement, next: string) {
                set.call(this, next)
                syncFromSelect()
            },
        })
    }

    if (toggles.length) {
        const toggleObserver = new MutationObserver(syncTogglesActive)
        for (const toggle of toggles) {
            toggleObserver.observe(toggle, { attributes: true, attributeFilter: ["aria-checked"] })
        }
        syncTogglesActive()
    }

    for (const secondarySelect of secondarySelects) setupSecondarySelect(secondarySelect)

    syncFromSelect()
}

function closeAllExcept(except: Element) {
    const wrappers = document.querySelectorAll("[data-sort-menu]")
    for (const wrapper of wrappers) {
        if (wrapper === except) continue
        const button = wrapper.querySelector<HTMLButtonElement>("[data-sort-menu-button]")
        const panel = wrapper.querySelector<HTMLElement>("[data-sort-menu-panel]")
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
