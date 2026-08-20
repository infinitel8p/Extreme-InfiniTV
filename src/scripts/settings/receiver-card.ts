// Settings card: TV receiver mode toggle, pairing info, paired-device list.
import { debounce } from "@/scripts/lib/debounce"
import { log } from "@/scripts/lib/log.js"
import { t } from "@/scripts/lib/i18n.js"
import { isTauri } from "@/scripts/lib/creds.js"
import {
  getReceiverModeEnabled,
  setReceiverModeEnabled,
  getReceiverBootEnabled,
  setReceiverBootEnabled,
  getReceiverDeviceName,
  setReceiverDeviceName,
  getEffectiveReceiverDeviceName,
} from "@/scripts/lib/app-settings.js"
import {
  formatReceiverAddress,
  formatReceiverPairCode,
  type ReceiverPairedDevice,
  type ReceiverStatus,
} from "@/scripts/lib/receiver-shared.js"
import { advertiseReceiver, stopAdvertisingReceiver } from "@/scripts/lib/receiver-discovery.js"

async function init(): Promise<void> {
  if (!isTauri) return

  const card = document.getElementById("card-tv-receiver")
  card?.classList.remove("hidden")

  const { invoke } = await import("@tauri-apps/api/core")
  const { listen } = await import("@tauri-apps/api/event")

  const modeGroup = document.getElementById("receiver-mode-toggle")
  const bootGroup = document.getElementById("receiver-boot-toggle")
  const deviceNameInput = document.getElementById(
    "receiver-device-name-input"
  ) as HTMLInputElement | null
  const statusBlock = document.getElementById("receiver-status-block")
  const addressesList = document.getElementById("receiver-addresses-list")
  const pairCodeDisplay = document.getElementById("receiver-pair-code-display")
  const regenerateBtn = document.getElementById("receiver-regenerate-btn")
  const openScreenBtn = document.getElementById("receiver-open-screen")
  const pairedList = document.getElementById("receiver-paired-list")
  const noDevicesEl = document.getElementById("receiver-no-devices")

  function syncModeButtons(): void {
    const enabled = getReceiverModeEnabled()
    for (const btn of modeGroup?.querySelectorAll<HTMLElement>(".receiver-mode-btn") ?? []) {
      btn.setAttribute("aria-checked", String((btn.dataset.receiver === "on") === enabled))
    }
  }

  function syncBootButtons(): void {
    const enabled = getReceiverBootEnabled()
    for (const btn of bootGroup?.querySelectorAll<HTMLElement>(".receiver-boot-btn") ?? []) {
      btn.setAttribute("aria-checked", String((btn.dataset.receiverBoot === "on") === enabled))
    }
  }

  function renderPairedDevices(devices: ReceiverPairedDevice[]): void {
    if (!pairedList) return
    pairedList.replaceChildren()
    noDevicesEl?.classList.toggle("hidden", devices.length > 0)
    for (const device of devices) {
      const row = document.createElement("div")
      row.className = "flex items-center justify-between gap-3 px-4 py-3"

      const textWrap = document.createElement("div")
      textWrap.className = "flex flex-col min-w-0"
      const nameEl = document.createElement("span")
      nameEl.className = "truncate text-sm font-medium"
      nameEl.textContent = device.deviceName
      const dateEl = document.createElement("span")
      dateEl.className = "text-2xs text-fg-3"
      dateEl.textContent = new Date(device.createdAt).toLocaleDateString()
      textWrap.append(nameEl, dateEl)

      const revokeBtn = document.createElement("button")
      revokeBtn.type = "button"
      revokeBtn.className = "btn flex-none"
      revokeBtn.textContent = t("settings.receiver.revoke")
      revokeBtn.addEventListener("click", () => void revokeDevice(device.key))

      row.append(textWrap, revokeBtn)
      pairedList.appendChild(row)
    }
    window.SpatialNavigation?.makeFocusable?.()
  }

  function renderStatus(status: ReceiverStatus): void {
    const enabled = !!status.enabled
    statusBlock?.classList.toggle("hidden", !enabled)
    statusBlock?.classList.toggle("flex", enabled)
    if (!enabled) return

    if (addressesList) {
      addressesList.replaceChildren()
      for (const ip of status.ips ?? []) {
        const row = document.createElement("div")
        row.textContent = formatReceiverAddress(ip, status.port)
        addressesList.appendChild(row)
      }
    }

    if (pairCodeDisplay) {
      pairCodeDisplay.textContent = formatReceiverPairCode(status.pairCode)
    }

    renderPairedDevices(status.pairedDevices ?? [])
  }

  async function refreshStatus(): Promise<void> {
    try {
      renderStatus(await invoke<ReceiverStatus>("receiver_status"))
    } catch (err) {
      log.warn("[settings:receiver] receiver_status failed:", err)
    }
  }

  async function revokeDevice(key: string): Promise<void> {
    try {
      await invoke("receiver_revoke_device", { key })
      await refreshStatus()
    } catch (err) {
      log.warn("[settings:receiver] receiver_revoke_device failed:", err)
    }
  }

  modeGroup?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    const btn = target.closest<HTMLElement>(".receiver-mode-btn")
    if (!btn) return
    const enabled = btn.dataset.receiver === "on"
    setReceiverModeEnabled(enabled)
    syncModeButtons()
    if (enabled) {
      invoke<ReceiverStatus>("receiver_start", { name: getEffectiveReceiverDeviceName() || undefined })
        .then((status) => {
          renderStatus(status)
          if (status.port !== undefined) advertiseReceiver(status.name, status.port)
        })
        .catch((err) => log.warn("[settings:receiver] receiver_start failed:", err))
    } else {
      invoke("receiver_stop")
        .then(refreshStatus)
        .then(stopAdvertisingReceiver)
        .catch((err) => log.warn("[settings:receiver] receiver_stop failed:", err))
    }
  })

  bootGroup?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    const btn = target.closest<HTMLElement>(".receiver-boot-btn")
    if (!btn) return
    setReceiverBootEnabled(btn.dataset.receiverBoot === "on")
    syncBootButtons()
  })

  regenerateBtn?.addEventListener("click", () => {
    invoke<ReceiverStatus>("receiver_regenerate_code")
      .then(renderStatus)
      .catch((err) => log.warn("[settings:receiver] receiver_regenerate_code failed:", err))
  })

  openScreenBtn?.addEventListener("click", () => {
    location.href = "/receiver"
  })

  if (deviceNameInput) {
    deviceNameInput.value = getReceiverDeviceName()
    const commitDeviceName = debounce((value: string) => {
      setReceiverDeviceName(value)
      if (!getReceiverModeEnabled()) return
      invoke<ReceiverStatus>("receiver_set_name", { name: value })
        .then((status) => {
          renderStatus(status)
          if (status.port !== undefined) advertiseReceiver(status.name, status.port)
        })
        .catch((err) => log.warn("[settings:receiver] receiver_set_name failed:", err))
    }, 600)
    deviceNameInput.addEventListener("input", () => commitDeviceName(deviceNameInput.value))
  }

  syncModeButtons()
  syncBootButtons()
  await refreshStatus()

  await listen<ReceiverStatus>("xt:receiver-status", (event) => renderStatus(event.payload))
  await listen("xt:receiver-paired", () => void refreshStatus())
}

void init()

export {}
