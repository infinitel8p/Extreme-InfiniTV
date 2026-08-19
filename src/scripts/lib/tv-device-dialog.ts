// Pairing + device picker for "Play on TV". Clones the player-picker-dialog shape.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import { ICON_DEVICE_TV, ICON_TRASH, ICON_X } from "@/scripts/lib/icons.js"
import { fmtAge } from "@/scripts/lib/format.js"
import {
  listTvDevices,
  pairTvDevice,
  probeTvDevice,
  removeTvDevice,
  validateDeviceInput,
  type TvDevice,
} from "@/scripts/lib/tv-cast.js"
import { discoverReceivers, type DiscoveredReceiver } from "@/scripts/lib/receiver-discovery.js"

const DIALOG_ID = "tv-device-picker"

let dlg: HTMLDialogElement | null = null

function ensureDialog(): HTMLDialogElement | null {
  if (typeof document === "undefined") return null
  if (dlg && document.body.contains(dlg)) return dlg
  const existing = document.getElementById(DIALOG_ID)
  if (existing instanceof HTMLDialogElement) {
    dlg = existing
    return dlg
  }
  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(32rem,calc(100vw-2rem))] max-h-[min(85dvh,40rem)]",
    "open:flex flex-col overflow-hidden",
    "backdrop:bg-black/60",
  ].join(" ")
  document.body.appendChild(node)
  dlg = node
  return dlg
}

export interface TvDevicePickerOptions {
  contentTitle?: string | null
  prefillHost?: string
  prefillPort?: number
}

export function openTvDevicePicker(
  options: TvDevicePickerOptions = {}
): Promise<TvDevice | null> {
  const dialog = ensureDialog()
  if (!dialog) return Promise.resolve(null)

  return new Promise((resolve) => {
    const devices = [...listTvDevices()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    const showAddFormByDefault = devices.length === 0

    const subtitleHtml = options.contentTitle
      ? `<div data-role="subtitle" class="text-sm text-fg-3 line-clamp-2"></div>`
      : ""

    dialog.innerHTML = `
      <div class="flex flex-col flex-auto min-h-0 p-5 sm:p-6 gap-5">
        <header class="flex items-start gap-3.5 shrink-0 px-3">
          <span class="icon-mark icon-mark--lg" aria-hidden="true">${ICON_DEVICE_TV}</span>
          <div class="flex flex-col gap-1 min-w-0 pt-0.5">
            <h2 id="${DIALOG_ID}-title" class="text-lg font-semibold leading-tight tracking-tight"></h2>
            ${subtitleHtml}
          </div>
          <button type="button" data-role="close" class="ms-auto shrink-0 min-h-11 min-w-11 grid place-items-center rounded-xl text-fg-3 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2">${ICON_X}</button>
        </header>
        <p data-role="empty" class="hidden text-sm text-fg-3 text-center py-1 px-4"></p>
        <div data-role="found-section" class="flex flex-col gap-2 shrink-0">
          <h3 data-role="found-title" class="text-xs font-medium text-fg-3 px-1"></h3>
          <ul data-role="found-list" class="flex flex-col gap-2.5 list-none m-0 p-0"></ul>
          <p data-role="found-status" class="hidden items-center gap-2 text-sm text-fg-3 px-1"></p>
        </div>
        <ul data-role="list" class="flex flex-col gap-2.5 overflow-y-auto min-h-0 list-none m-0 p-0"></ul>
        <div data-role="add-section" class="flex flex-col gap-3 shrink-0">
          <button type="button" data-role="toggle-add" class="btn self-start"></button>
          <form data-role="add-form" class="flex flex-col gap-3">
            <div class="flex flex-col gap-1">
              <label for="${DIALOG_ID}-host" data-role="host-label" class="text-xs font-medium text-fg-2"></label>
              <input id="${DIALOG_ID}-host" data-role="host-input" type="text" autocomplete="off" class="field-input" />
              <span data-role="host-error" class="hidden text-xs text-bad"></span>
            </div>
            <div class="flex gap-3">
              <div class="flex flex-col gap-1 flex-1">
                <label for="${DIALOG_ID}-port" data-role="port-label" class="text-xs font-medium text-fg-2"></label>
                <input id="${DIALOG_ID}-port" data-role="port-input" type="number" placeholder="47815" inputmode="numeric" class="field-input" />
                <span data-role="port-error" class="hidden text-xs text-bad"></span>
              </div>
              <div class="flex flex-col gap-1 flex-1">
                <label for="${DIALOG_ID}-code" data-role="code-label" class="text-xs font-medium text-fg-2"></label>
                <input id="${DIALOG_ID}-code" data-role="code-input" type="text" inputmode="numeric" maxlength="6" autocomplete="off" class="field-input tabular-nums" />
                <span data-role="code-error" class="hidden text-xs text-bad"></span>
              </div>
            </div>
            <span data-role="form-error" class="hidden text-xs text-bad"></span>
            <button type="submit" data-role="pair-submit" class="btn-primary self-start"></button>
          </form>
        </div>
      </div>
    `

    const titleEl = dialog.querySelector<HTMLElement>("h2")!
    titleEl.textContent = t("cast.picker.title")
    if (options.contentTitle) {
      const subtitleEl = dialog.querySelector<HTMLElement>('[data-role="subtitle"]')
      if (subtitleEl) subtitleEl.textContent = options.contentTitle
    }
    const closeBtn = dialog.querySelector<HTMLElement>('[data-role="close"]')!
    closeBtn.setAttribute("aria-label", t("common.cancel"))

    const listEl = dialog.querySelector<HTMLUListElement>('[data-role="list"]')!
    const emptyEl = dialog.querySelector<HTMLElement>('[data-role="empty"]')!
    emptyEl.textContent = t("cast.picker.empty")
    emptyEl.classList.toggle("hidden", devices.length > 0)

    const foundListEl = dialog.querySelector<HTMLUListElement>('[data-role="found-list"]')!
    const foundStatusEl = dialog.querySelector<HTMLElement>('[data-role="found-status"]')!
    dialog.querySelector<HTMLElement>('[data-role="found-title"]')!.textContent = t("cast.picker.found")

    const toggleAddBtn = dialog.querySelector<HTMLButtonElement>('[data-role="toggle-add"]')!
    toggleAddBtn.textContent = t("cast.picker.add")
    toggleAddBtn.classList.toggle("hidden", showAddFormByDefault)

    const addForm = dialog.querySelector<HTMLFormElement>('[data-role="add-form"]')!
    addForm.classList.toggle("hidden", !showAddFormByDefault)

    dialog.querySelector<HTMLElement>('[data-role="host-label"]')!.textContent = t("cast.picker.host")
    dialog.querySelector<HTMLElement>('[data-role="port-label"]')!.textContent = t("cast.picker.port")
    dialog.querySelector<HTMLElement>('[data-role="code-label"]')!.textContent = t("cast.picker.code")
    dialog.querySelector<HTMLButtonElement>('[data-role="pair-submit"]')!.textContent = t("cast.picker.pair")

    const hostInput = dialog.querySelector<HTMLInputElement>('[data-role="host-input"]')!
    const portInput = dialog.querySelector<HTMLInputElement>('[data-role="port-input"]')!
    const codeInput = dialog.querySelector<HTMLInputElement>('[data-role="code-input"]')!
    const hostError = dialog.querySelector<HTMLElement>('[data-role="host-error"]')!
    const portError = dialog.querySelector<HTMLElement>('[data-role="port-error"]')!
    const codeError = dialog.querySelector<HTMLElement>('[data-role="code-error"]')!
    const formError = dialog.querySelector<HTMLElement>('[data-role="form-error"]')!

    if (options.prefillHost) hostInput.value = options.prefillHost
    if (options.prefillPort) portInput.value = String(options.prefillPort)

    function clearFieldErrors(): void {
      for (const el of [hostError, portError, codeError, formError]) {
        el.textContent = ""
        el.classList.add("hidden")
      }
    }

    function renderRow(device: TvDevice): HTMLLIElement {
      const row = document.createElement("li")
      row.className = "flex items-center gap-2"

      const connectBtn = document.createElement("button")
      connectBtn.type = "button"
      connectBtn.dataset.role = "device-btn"
      connectBtn.dataset.id = device.id
      connectBtn.className =
        "xt-picker-row flex-1 min-w-0 flex items-center gap-3.5 min-h-11 px-3 py-2.5 rounded-xl border border-line bg-surface text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent active:scale-[0.98]"

      const icon = document.createElement("span")
      icon.dataset.role = "device-icon"
      icon.className = "shrink-0 w-10 h-10 rounded-xl bg-surface-2 grid place-items-center text-fg-3"
      icon.setAttribute("aria-hidden", "true")
      icon.innerHTML = ICON_DEVICE_TV
      connectBtn.appendChild(icon)

      const textCol = document.createElement("span")
      textCol.className = "flex flex-col min-w-0 flex-1 gap-0.5"

      const nameEl = document.createElement("span")
      nameEl.dataset.role = "name"
      nameEl.className = "text-sm font-medium truncate"
      nameEl.textContent = device.name
      textCol.appendChild(nameEl)

      const metaRow = document.createElement("span")
      metaRow.className = "flex items-center gap-2 text-xs text-fg-3"

      const hostPortEl = document.createElement("span")
      hostPortEl.className = "tabular-nums truncate"
      hostPortEl.textContent = `${device.host}:${device.port}`
      metaRow.appendChild(hostPortEl)

      const lastUsedAge = fmtAge(device.lastSeenAt)
      if (lastUsedAge) {
        const lastUsedEl = document.createElement("span")
        lastUsedEl.dataset.role = "lastused"
        lastUsedEl.textContent = t("cast.picker.lastUsed", { when: lastUsedAge })
        metaRow.appendChild(lastUsedEl)
      }

      textCol.appendChild(metaRow)

      const rowErrorEl = document.createElement("span")
      rowErrorEl.dataset.role = "row-error"
      rowErrorEl.className = "hidden text-xs text-bad"
      textCol.appendChild(rowErrorEl)

      connectBtn.appendChild(textCol)
      row.appendChild(connectBtn)

      const forgetBtn = document.createElement("button")
      forgetBtn.type = "button"
      forgetBtn.dataset.role = "forget-btn"
      forgetBtn.dataset.id = device.id
      forgetBtn.className = "btn shrink-0 min-h-11 min-w-11"
      forgetBtn.setAttribute("aria-label", t("cast.picker.forget"))
      forgetBtn.innerHTML = ICON_TRASH
      row.appendChild(forgetBtn)

      return row
    }

    function renderList(): void {
      listEl.replaceChildren(...devices.map(renderRow))
    }
    renderList()

    function renderFoundRow(receiver: DiscoveredReceiver): HTMLLIElement {
      const row = document.createElement("li")
      row.className = "flex items-center gap-2"

      const foundBtn = document.createElement("button")
      foundBtn.type = "button"
      foundBtn.dataset.role = "found-btn"
      foundBtn.className =
        "xt-picker-row flex-1 min-w-0 flex items-center gap-3.5 min-h-11 px-3 py-2.5 rounded-xl border border-line bg-surface text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent active:scale-[0.98]"

      const icon = document.createElement("span")
      icon.className = "shrink-0 w-10 h-10 rounded-xl bg-surface-2 grid place-items-center text-fg-3"
      icon.setAttribute("aria-hidden", "true")
      icon.innerHTML = ICON_DEVICE_TV
      foundBtn.appendChild(icon)

      const textCol = document.createElement("span")
      textCol.className = "flex flex-col min-w-0 flex-1 gap-0.5"

      const nameEl = document.createElement("span")
      nameEl.className = "text-sm font-medium truncate"
      nameEl.textContent = receiver.name
      textCol.appendChild(nameEl)

      const hostPortEl = document.createElement("span")
      hostPortEl.className = "text-xs text-fg-3 tabular-nums truncate"
      hostPortEl.textContent = `${receiver.host}:${receiver.port}`
      textCol.appendChild(hostPortEl)

      foundBtn.appendChild(textCol)
      row.appendChild(foundBtn)

      foundBtn.addEventListener("click", () => {
        hostInput.value = receiver.host
        portInput.value = String(receiver.port)
        addForm.classList.remove("hidden")
        toggleAddBtn.classList.add("hidden")
        codeInput.focus()
      })

      return row
    }

    let discoveredReceivers: DiscoveredReceiver[] = []
    let discoverySearching = true

    function renderFound(): void {
      const pairedKeys = new Set(devices.map((device) => `${device.host}:${device.port}`))
      const unpaired = discoveredReceivers.filter(
        (receiver) => !pairedKeys.has(`${receiver.host}:${receiver.port}`)
      )
      foundListEl.replaceChildren(...unpaired.map(renderFoundRow))
      const showStatus = unpaired.length === 0
      foundStatusEl.classList.toggle("hidden", !showStatus)
      foundStatusEl.classList.toggle("flex", showStatus)
      if (showStatus) {
        foundStatusEl.innerHTML = discoverySearching
          ? `<span class="size-4 rounded-full border-2 border-line border-t-accent animate-spin shrink-0" aria-hidden="true"></span><span>${t("cast.picker.searching")}</span>`
          : ""
        if (!discoverySearching) foundStatusEl.textContent = t("cast.picker.noneFound")
      }
      window.SpatialNavigation?.makeFocusable?.()
    }
    renderFound()

    const DISCOVERY_TIMEOUT_MS = 3000
    const cancelDiscovery = discoverReceivers((list) => {
      discoveredReceivers = list
      renderFound()
    }, DISCOVERY_TIMEOUT_MS)
    const discoveryDoneTimer = setTimeout(() => {
      discoverySearching = false
      renderFound()
    }, DISCOVERY_TIMEOUT_MS)

    let resolved = false
    const settle = (choice: TvDevice | null) => {
      if (resolved) return
      resolved = true
      detach()
      try {
        if (dialog.open) dialog.close()
      } catch {}
      resolve(choice)
    }

    async function connectTo(device: TvDevice, row: HTMLLIElement): Promise<void> {
      const button = row.querySelector<HTMLButtonElement>('[data-role="device-btn"]')!
      const iconEl = row.querySelector<HTMLElement>('[data-role="device-icon"]')!
      const rowErrorEl = row.querySelector<HTMLElement>('[data-role="row-error"]')!
      button.disabled = true
      iconEl.classList.add("animate-spin")
      rowErrorEl.classList.add("hidden")
      const probed = await probeTvDevice(device.host, device.port)
      if (!probed) {
        button.disabled = false
        iconEl.classList.remove("animate-spin")
        rowErrorEl.textContent = t("cast.pair.unreachable")
        rowErrorEl.classList.remove("hidden")
        return
      }
      settle(device)
    }

    const onListClick = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      const forgetBtn = target.closest<HTMLElement>('[data-role="forget-btn"]')
      if (forgetBtn) {
        const id = forgetBtn.dataset.id
        if (id) {
          removeTvDevice(id)
          const index = devices.findIndex((device) => device.id === id)
          if (index !== -1) devices.splice(index, 1)
          renderList()
          emptyEl.classList.toggle("hidden", devices.length > 0)
        }
        return
      }
      const deviceBtn = target.closest<HTMLElement>('[data-role="device-btn"]')
      if (deviceBtn) {
        const id = deviceBtn.dataset.id
        const device = devices.find((entry) => entry.id === id)
        const row = deviceBtn.closest<HTMLLIElement>("li")
        if (device && row) void connectTo(device, row)
      }
    }
    listEl.addEventListener("click", onListClick)

    const onToggleAdd = () => {
      addForm.classList.toggle("hidden")
    }
    toggleAddBtn.addEventListener("click", onToggleAdd)

    const onFormSubmit = async (event: Event) => {
      event.preventDefault()
      clearFieldErrors()
      const result = validateDeviceInput({
        host: hostInput.value,
        port: portInput.value,
        code: codeInput.value,
      })
      if (!result.ok) {
        const fieldError = result.reason === "host" ? hostError : result.reason === "port" ? portError : codeError
        const fieldErrorKey =
          result.reason === "host"
            ? "cast.pair.badHost"
            : result.reason === "port"
              ? "cast.pair.badPort"
              : "cast.pair.badCodeFormat"
        fieldError.textContent = t(fieldErrorKey)
        fieldError.classList.remove("hidden")
        return
      }
      const submitBtn = dialog.querySelector<HTMLButtonElement>('[data-role="pair-submit"]')!
      submitBtn.disabled = true
      submitBtn.dataset.loading = "true"
      try {
        const device = await pairTvDevice({ host: result.host, port: result.port, code: result.code })
        settle(device)
      } catch (err) {
        submitBtn.disabled = false
        delete submitBtn.dataset.loading
        const message = err instanceof Error ? err.message : ""
        formError.textContent = message === "badCode" ? t("cast.pair.badCode") : t("cast.pair.unreachable")
        formError.classList.remove("hidden")
      }
    }
    addForm.addEventListener("submit", onFormSubmit)

    const onClick = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-role="close"]')) {
        settle(null)
        return
      }
      if (target === dialog) settle(null)
    }

    const onCancel = (event: Event) => {
      event.preventDefault()
      settle(null)
    }

    const onClose = () => {
      settle(null)
    }

    const onLocaleChange = () => {
      if (resolved) return
      resolved = true
      detach()
      try {
        if (dialog.open) dialog.close()
      } catch {}
      void openTvDevicePicker(options).then(resolve, () => resolve(null))
    }

    function detach() {
      cancelDiscovery()
      clearTimeout(discoveryDoneTimer)
      listEl.removeEventListener("click", onListClick)
      toggleAddBtn.removeEventListener("click", onToggleAdd)
      addForm.removeEventListener("submit", onFormSubmit)
      dialog.removeEventListener("click", onClick)
      dialog.removeEventListener("cancel", onCancel)
      dialog.removeEventListener("close", onClose)
      document.removeEventListener(LOCALE_EVENT, onLocaleChange)
    }

    dialog.addEventListener("click", onClick)
    dialog.addEventListener("cancel", onCancel)
    dialog.addEventListener("close", onClose)
    document.addEventListener(LOCALE_EVENT, onLocaleChange)

    try {
      dialog.showModal()
    } catch {
      detach()
      resolve(null)
      return
    }

    attachDialogSpatialNav(dialog, {
      defaultElement: `#${DIALOG_ID} [data-role="device-btn"], #${DIALOG_ID} [data-role="toggle-add"], #${DIALOG_ID} [data-role="host-input"]`,
    })

    const firstFocusable =
      dialog.querySelector<HTMLElement>('[data-role="device-btn"]') ||
      dialog.querySelector<HTMLElement>('[data-role="host-input"]')
    firstFocusable?.focus()
  })
}
