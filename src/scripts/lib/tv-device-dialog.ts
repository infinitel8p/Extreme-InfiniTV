// Pairing + device picker for "Play on TV". Clones the player-picker-dialog shape.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { isTauri } from "@/scripts/lib/creds.js"
import { log } from "@/scripts/lib/log.js"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import { ICON_DEVICE_TV, ICON_TRASH, ICON_X } from "@/scripts/lib/icons.js"
import { fmtAge } from "@/scripts/lib/format.js"
import {
  listTvDevices,
  pairTvDevice,
  probeTvDevice,
  removeTvDevice,
  validateDeviceInput,
  deviceKnownHostEntries,
  type TvDevice,
} from "@/scripts/lib/tv-cast.js"
import { discoverReceivers, type DiscoveredReceiver } from "@/scripts/lib/receiver-discovery.js"

const DIALOG_ID = "tv-device-picker"
const DEFAULT_RECEIVER_PORT = 47815

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
  mode?: "pick" | "add"
  contentTitle?: string | null
  prefillHost?: string
  prefillPort?: number
}

export function openTvDevicePicker(
  options: TvDevicePickerOptions = {}
): Promise<TvDevice | null> {
  const dialog = ensureDialog()
  if (!dialog) return Promise.resolve(null)

  const dialogEl: HTMLDialogElement = dialog

  return new Promise((resolve) => {
    const addMode = options.mode === "add"
    const devices = [...listTvDevices()]
    const showAddFormByDefault = addMode || devices.length === 0
    const knownHosts = devices.flatMap(deviceKnownHostEntries)

    const subtitleHtml = options.contentTitle
      ? `<div data-role="subtitle" class="text-sm text-fg-3 line-clamp-2"></div>`
      : ""

    dialog.innerHTML = `
      <div class="flex flex-col flex-auto min-h-0 p-5 sm:p-6 gap-4">
        <header class="flex items-start gap-3.5 shrink-0 px-3">
          <span class="icon-mark icon-mark--lg" aria-hidden="true">${ICON_DEVICE_TV}</span>
          <div class="flex flex-col gap-1 min-w-0 pt-0.5">
            <h2 id="${DIALOG_ID}-title" class="text-lg font-semibold leading-tight tracking-tight"></h2>
            ${subtitleHtml}
          </div>
          <button type="button" data-role="close" class="ms-auto shrink-0 min-h-11 min-w-11 grid place-items-center rounded-xl text-fg-3 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2">${ICON_X}</button>
        </header>
        <ul data-role="list" class="flex flex-col gap-1 overflow-y-auto min-h-0 list-none m-0 p-0"></ul>
        <div data-role="scan-line" class="flex items-center gap-3 shrink-0 px-3 min-h-11">
          <span data-role="scan-status" class="flex items-center gap-2 min-w-0 text-sm text-fg-3"></span>
          <button type="button" data-role="rescan-btn" class="hidden shrink-0 ms-auto inline-flex items-center min-h-11 px-2.5 -me-2.5 rounded-xl text-sm text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2"></button>
        </div>
        <p data-role="empty-hint" class="hidden shrink-0 px-3 text-sm text-fg-3"></p>
        <div data-role="add-section" class="flex flex-col gap-3 shrink-0 px-3">
          <button type="button" data-role="toggle-add" class="btn self-end"></button>
          <form data-role="add-form" class="flex flex-col gap-3">
            <div class="flex flex-col gap-1">
              <label for="${DIALOG_ID}-host" data-role="host-label" class="text-xs font-medium text-fg-2"></label>
              <input id="${DIALOG_ID}-host" data-role="host-input" type="text" autocomplete="off" class="field-input" />
              <span data-role="host-error" class="hidden text-xs text-bad"></span>
            </div>
            <div class="flex gap-3">
              <div class="flex flex-col gap-1 flex-1">
                <label for="${DIALOG_ID}-port" data-role="port-label" class="text-xs font-medium text-fg-2"></label>
                <input id="${DIALOG_ID}-port" data-role="port-input" type="number" inputmode="numeric" class="field-input" />
                <span data-role="port-error" class="hidden text-xs text-bad"></span>
              </div>
              <div class="flex flex-col gap-1 flex-1">
                <label for="${DIALOG_ID}-code" data-role="code-label" class="text-xs font-medium text-fg-2"></label>
                <input id="${DIALOG_ID}-code" data-role="code-input" type="text" inputmode="numeric" maxlength="6" autocomplete="off" class="field-input tabular-nums" />
                <span data-role="code-error" class="hidden text-xs text-bad"></span>
              </div>
            </div>
            <span data-role="form-error" class="hidden text-xs text-bad"></span>
            <button type="submit" data-role="pair-submit" class="btn-primary self-end"></button>
          </form>
        </div>
      </div>
    `

    const titleEl = dialog.querySelector<HTMLElement>("h2")!
    titleEl.textContent = t(addMode ? "cast.picker.addTitle" : "cast.picker.title")
    if (options.contentTitle) {
      const subtitleEl = dialog.querySelector<HTMLElement>('[data-role="subtitle"]')
      if (subtitleEl) subtitleEl.textContent = options.contentTitle
    }
    const closeBtn = dialog.querySelector<HTMLElement>('[data-role="close"]')!
    closeBtn.setAttribute("aria-label", t("common.cancel"))

    const listEl = dialog.querySelector<HTMLUListElement>('[data-role="list"]')!
    const scanStatusEl = dialog.querySelector<HTMLElement>('[data-role="scan-status"]')!
    const emptyHintEl = dialog.querySelector<HTMLElement>('[data-role="empty-hint"]')!
    emptyHintEl.textContent = t("cast.picker.emptyHint")
    const rescanBtn = dialog.querySelector<HTMLButtonElement>('[data-role="rescan-btn"]')!
    rescanBtn.textContent = t("cast.picker.rescan")

    const toggleAddBtn = dialog.querySelector<HTMLButtonElement>('[data-role="toggle-add"]')!
    toggleAddBtn.textContent = t("cast.picker.addTv")
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
    portInput.value = String(options.prefillPort || DEFAULT_RECEIVER_PORT)

    function clearFieldErrors(): void {
      for (const el of [hostError, portError, codeError, formError]) {
        el.textContent = ""
        el.classList.add("hidden")
      }
    }

    const ROW_BTN_CLASS =
      "xt-picker-row flex-1 min-w-0 flex items-center gap-3.5 min-h-11 px-3 py-2.5 rounded-xl text-left hover:bg-surface-2 focus-visible:bg-surface-2 active:scale-[0.98]"

    /** Appends a muted " +N" hint to a host:port label when more addresses are known. */
    function appendHostsHint(hostPortEl: HTMLElement, hosts: string[] | undefined): void {
      if (!hosts || hosts.length <= 1) return
      const hintEl = document.createElement("span")
      hintEl.className = "text-fg-3/70"
      hintEl.textContent = ` +${hosts.length - 1}`
      hostPortEl.appendChild(hintEl)
    }

    function renderRow(device: TvDevice, online: boolean): HTMLLIElement {
      const row = document.createElement("li")
      row.className = "flex items-center gap-1"

      const connectBtn = document.createElement("button")
      connectBtn.type = "button"
      connectBtn.dataset.role = "device-btn"
      connectBtn.dataset.id = device.id
      connectBtn.className = ROW_BTN_CLASS

      const icon = document.createElement("span")
      icon.dataset.role = "device-icon"
      icon.className = "shrink-0 grid place-items-center text-fg-3"
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
      appendHostsHint(hostPortEl, device.hosts)
      metaRow.appendChild(hostPortEl)

      if (online) {
        const onlineEl = document.createElement("span")
        onlineEl.className = "inline-flex items-center gap-1.5"
        const dot = document.createElement("span")
        dot.className = "size-1.5 rounded-full bg-ok"
        dot.setAttribute("aria-hidden", "true")
        onlineEl.appendChild(dot)
        onlineEl.appendChild(document.createTextNode(t("cast.picker.online")))
        metaRow.appendChild(onlineEl)
      } else {
        const lastUsedAge = fmtAge(device.lastSeenAt)
        if (lastUsedAge) {
          const lastUsedEl = document.createElement("span")
          lastUsedEl.dataset.role = "lastused"
          lastUsedEl.textContent = t("cast.picker.lastUsed", { when: lastUsedAge })
          metaRow.appendChild(lastUsedEl)
        }
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
      forgetBtn.className =
        "shrink-0 min-h-11 min-w-11 grid place-items-center rounded-xl text-fg-3 hover:bg-surface-2 hover:text-bad focus-visible:bg-surface-2"
      forgetBtn.setAttribute("aria-label", t("cast.picker.forget"))
      forgetBtn.innerHTML = ICON_TRASH
      row.appendChild(forgetBtn)

      return row
    }

    function renderFoundRow(receiver: DiscoveredReceiver): HTMLLIElement {
      const row = document.createElement("li")
      row.className = "flex items-center gap-1"

      const hostPortKey = `${receiver.host}:${receiver.port}`

      const foundBtn = document.createElement("button")
      foundBtn.type = "button"
      foundBtn.dataset.role = "found-btn"
      foundBtn.dataset.hostport = hostPortKey
      foundBtn.className = ROW_BTN_CLASS

      const icon = document.createElement("span")
      icon.className = "shrink-0 grid place-items-center text-fg-3"
      icon.setAttribute("aria-hidden", "true")
      icon.innerHTML = ICON_DEVICE_TV
      foundBtn.appendChild(icon)

      const textCol = document.createElement("span")
      textCol.className = "flex flex-col min-w-0 flex-1 gap-0.5"

      const nameEl = document.createElement("span")
      nameEl.className = "text-sm font-medium truncate"
      nameEl.textContent = receiver.name
      textCol.appendChild(nameEl)

      const metaRow = document.createElement("span")
      metaRow.className = "flex items-center gap-2 text-xs text-fg-3"

      const hostPortEl = document.createElement("span")
      hostPortEl.className = "tabular-nums truncate"
      hostPortEl.textContent = hostPortKey
      appendHostsHint(hostPortEl, receiver.hosts)
      metaRow.appendChild(hostPortEl)

      const statusEl = document.createElement("span")
      statusEl.dataset.role = "reachability"
      statusEl.className = "inline-flex items-center gap-1.5 shrink-0"
      metaRow.appendChild(statusEl)
      renderReachabilityStatus(statusEl, reachability.get(hostPortKey))

      textCol.appendChild(metaRow)

      foundBtn.appendChild(textCol)

      const pairLabel = document.createElement("span")
      pairLabel.className = "shrink-0 text-xs font-medium text-accent"
      pairLabel.textContent = t("cast.picker.pair")
      foundBtn.appendChild(pairLabel)

      row.appendChild(foundBtn)

      foundBtn.addEventListener("click", () => {
        hostInput.value = receiver.host
        portInput.value = String(receiver.port)
        pendingHosts = receiver.hosts?.length ? receiver.hosts : [receiver.host]
        pendingId = receiver.id
        addForm.classList.remove("hidden")
        toggleAddBtn.classList.add("hidden")
        codeInput.focus()
      })

      ensureReachabilityProbe(receiver, hostPortKey)

      return row
    }

    type ReachabilityStatus = "online" | "unreachable"
    const REACHABILITY_TIMEOUT_MS = 2500
    // host:port -> latest known status, and the in-flight probe (deduped per discovery refresh).
    const reachability = new Map<string, ReachabilityStatus>()
    const reachabilityProbes = new Map<string, Promise<void>>()
    let discoveryToken = 0

    function renderReachabilityStatus(statusEl: HTMLElement, status: ReachabilityStatus | undefined): void {
      statusEl.replaceChildren()
      const dot = document.createElement("span")
      dot.setAttribute("aria-hidden", "true")
      dot.className = `size-1.5 rounded-full ${status === "online" ? "bg-ok" : "bg-fg-3/40"}`
      statusEl.appendChild(dot)
      if (status === "online") {
        statusEl.appendChild(document.createTextNode(t("cast.picker.online")))
      } else if (status === "unreachable") {
        statusEl.appendChild(document.createTextNode(t("cast.picker.unreachable")))
      }
    }

    function updateReachabilityRow(hostPortKey: string): void {
      const statusEl = listEl.querySelector<HTMLElement>(
        `[data-role="found-btn"][data-hostport="${CSS.escape(hostPortKey)}"] [data-role="reachability"]`
      )
      if (statusEl) renderReachabilityStatus(statusEl, reachability.get(hostPortKey))
    }

    // Advisory only: probes never block the row from rendering or staying clickable.
    function ensureReachabilityProbe(receiver: DiscoveredReceiver, hostPortKey: string): void {
      if (reachabilityProbes.has(hostPortKey)) return
      const token = discoveryToken
      const probe = (async () => {
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), REACHABILITY_TIMEOUT_MS))
        const result = await Promise.race([
          probeTvDevice(receiver.host, receiver.port, receiver.hosts),
          timeout,
        ]).catch(() => null)
        if (token !== discoveryToken || !listEl.isConnected) return
        reachability.set(hostPortKey, result ? "online" : "unreachable")
        updateReachabilityRow(hostPortKey)
      })()
      reachabilityProbes.set(hostPortKey, probe)
    }

    // Candidate hosts + mDNS id of the discovered receiver a found-row click is about to pair.
    let pendingHosts: string[] | undefined
    let pendingId: string | undefined

    let discoveredReceivers: DiscoveredReceiver[] = []
    let discoverySearching = true
    let discoveryFailed = false
    const selfHostPorts = new Set<string>()

    // Same receiver as a discovered entry when the mDNS ids match, else when any known host overlaps.
    function isSameReceiver(device: TvDevice, receiver: DiscoveredReceiver): boolean {
      if (device.id && receiver.id && device.id === receiver.id) return true
      if (device.port !== receiver.port) return false
      const deviceHosts = device.hosts?.length ? device.hosts : [device.host]
      const receiverHosts = receiver.hosts?.length ? receiver.hosts : [receiver.host]
      return deviceHosts.some((host) => receiverHosts.includes(host))
    }

    function renderAll(): void {
      const unpaired = discoveredReceivers.filter((receiver) => {
        const key = `${receiver.host}:${receiver.port}`
        if (selfHostPorts.has(key)) return false
        return !devices.some((device) => isSameReceiver(device, receiver))
      })

      const savedSorted = addMode
        ? []
        : [...devices].sort((a, b) => {
            const aOnline = discoveredReceivers.some((receiver) => isSameReceiver(a, receiver)) ? 1 : 0
            const bOnline = discoveredReceivers.some((receiver) => isSameReceiver(b, receiver)) ? 1 : 0
            if (aOnline !== bOnline) return bOnline - aOnline
            return b.lastSeenAt - a.lastSeenAt
          })

      const rows = [
        ...savedSorted.map((device) =>
          renderRow(device, discoveredReceivers.some((receiver) => isSameReceiver(device, receiver)))
        ),
        ...unpaired.map(renderFoundRow),
      ]
      listEl.replaceChildren(...rows)
      listEl.classList.toggle("hidden", rows.length === 0)

      if (discoverySearching) {
        scanStatusEl.innerHTML = `<span class="size-4 rounded-full border-2 border-line border-t-accent animate-spin shrink-0" aria-hidden="true"></span><span></span>`
        scanStatusEl.lastElementChild!.textContent = t("cast.picker.searching")
      } else if (discoveryFailed) {
        scanStatusEl.textContent = t("cast.picker.scanFailed")
      } else if (rows.length === 0) {
        scanStatusEl.textContent = t("cast.picker.noTvsFound")
      } else if (unpaired.length === 0) {
        scanStatusEl.textContent = t("cast.picker.noNewFound")
      } else {
        scanStatusEl.textContent = ""
      }
      scanStatusEl.classList.toggle("hidden", scanStatusEl.textContent === "" && !discoverySearching)
      rescanBtn.classList.toggle("hidden", discoverySearching)
      emptyHintEl.classList.toggle("hidden", discoverySearching || discoveryFailed || rows.length > 0)

      window.SpatialNavigation?.makeFocusable?.()
    }
    renderAll()

    const DISCOVERY_TIMEOUT_MS = 5000
    let cancelDiscovery = () => {}

    function startDiscoveryScan(force = false): void {
      cancelDiscovery()
      discoveryToken += 1
      reachability.clear()
      reachabilityProbes.clear()
      discoveredReceivers = []
      discoverySearching = true
      discoveryFailed = false
      renderAll()
      cancelDiscovery = discoverReceivers(
        (list) => {
          discoveredReceivers = list
          renderAll()
        },
        DISCOVERY_TIMEOUT_MS,
        (errorMessage) => {
          discoverySearching = false
          discoveryFailed = errorMessage !== null
          if (errorMessage) log.warn("[xt:tv-device-dialog] receiver scan failed:", errorMessage)
          renderAll()
        },
        { knownHosts, force }
      )
    }
    startDiscoveryScan()

    const onRescanClick = () => startDiscoveryScan(true)
    rescanBtn.addEventListener("click", onRescanClick)

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
      const probed = await probeTvDevice(device.host, device.port, device.hosts)
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
          renderAll()
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
      pendingHosts = undefined
      pendingId = undefined
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
        const device = await pairTvDevice({
          host: result.host,
          port: result.port,
          code: result.code,
          hosts: pendingHosts,
          id: pendingId,
        })
        settle(device)
      } catch (err) {
        submitBtn.disabled = false
        delete submitBtn.dataset.loading
        const message = err instanceof Error ? err.message : ""
        formError.textContent =
          message === "badCode"
            ? t("cast.pair.badCode")
            : message === "rateLimited"
              ? t("cast.pair.rateLimited")
              : t("cast.pair.unreachable")
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
      rescanBtn.removeEventListener("click", onRescanClick)
      listEl.removeEventListener("click", onListClick)
      toggleAddBtn.removeEventListener("click", onToggleAdd)
      addForm.removeEventListener("submit", onFormSubmit)
      dialogEl.removeEventListener("click", onClick)
      dialogEl.removeEventListener("cancel", onCancel)
      dialogEl.removeEventListener("close", onClose)
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
      defaultElement: `#${DIALOG_ID} [data-role="device-btn"], #${DIALOG_ID} [data-role="found-btn"], #${DIALOG_ID} [data-role="toggle-add"], #${DIALOG_ID} [data-role="host-input"]`,
    })

    if (isTauri) {
      void (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core")
          const status = await invoke<{ enabled: boolean; port?: number; ips?: string[] }>("receiver_status")
          if (typeof status.port === "number" && status.ips?.length) {
            for (const ip of status.ips) selfHostPorts.add(`${ip}:${status.port}`)
            renderAll()
          }
        } catch {}
      })()
    }

    const firstFocusable =
      dialog.querySelector<HTMLElement>('[data-role="device-btn"]') ||
      dialog.querySelector<HTMLElement>('[data-role="found-btn"]') ||
      dialog.querySelector<HTMLElement>('[data-role="host-input"]')
    firstFocusable?.focus()
  })
}
