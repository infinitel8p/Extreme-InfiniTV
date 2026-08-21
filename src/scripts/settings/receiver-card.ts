// Settings card: TV receiver mode toggle, pairing info, paired-device list.
import { debounce } from "@/scripts/lib/debounce"
import { log } from "@/scripts/lib/log.js"
import { t } from "@/scripts/lib/i18n.js"
import { isTauri } from "@/scripts/lib/creds.js"
import { toastSuccess, toastError } from "@/scripts/lib/toast.js"
import { confirmDialog } from "@/scripts/lib/confirm-dialog.js"
import { writeClipboardText } from "@/scripts/lib/clipboard.js"
import { ICON_COPY } from "@/scripts/lib/icons.js"
import {
  getReceiverModeEnabled,
  setReceiverModeEnabled,
  getReceiverBootEnabled,
  setReceiverBootEnabled,
  getReceiverDeviceName,
  setReceiverDeviceName,
  getEffectiveReceiverDeviceName,
  getReceiverId,
} from "@/scripts/lib/app-settings.js"
import {
  formatReceiverAddress,
  formatReceiverPairCode,
  rankReceiverIps,
  type ReceiverPairedDevice,
  type ReceiverStatus,
} from "@/scripts/lib/receiver-shared.js"
import { advertiseReceiver, stopAdvertisingReceiver, getAdvertiseState } from "@/scripts/lib/receiver-discovery.js"
import { startReceiverKeepAlive, stopReceiverKeepAlive } from "@/scripts/lib/receiver-keep-alive"

const MASKED_PAIR_CODE = "••• •••"

async function init(): Promise<void> {
  if (!isTauri) return

  const card = document.getElementById("card-tv-receiver") as HTMLDetailsElement | null
  card?.classList.remove("hidden")
  document.getElementById("card-casting")?.classList.remove("hidden")

  const { invoke } = await import("@tauri-apps/api/core")
  const { listen } = await import("@tauri-apps/api/event")

  const modeGroup = document.getElementById("receiver-mode-toggle")
  const bootGroup = document.getElementById("receiver-boot-toggle")
  const deviceNameInput = document.getElementById(
    "receiver-device-name-input"
  ) as HTMLInputElement | null
  const statusBlock = document.getElementById("receiver-status-block")
  const liveBadge = document.getElementById("receiver-live-badge")
  const summaryHelper = document.getElementById("receiver-summary-helper")
  const summaryStatus = document.getElementById("receiver-summary-status")
  const statusLineText = document.getElementById("receiver-status-line-text")
  const discoverableLine = document.getElementById("receiver-discoverable-line")
  const addressesList = document.getElementById("receiver-addresses-list")
  const pairCodeDisplay = document.getElementById("receiver-pair-code-display")
  const codeRevealBtn = document.getElementById("receiver-code-reveal")
  const codeShowIcon = codeRevealBtn?.querySelector<HTMLElement>('[data-receiver-reveal-icon="show"]')
  const codeHideIcon = codeRevealBtn?.querySelector<HTMLElement>('[data-receiver-reveal-icon="hide"]')
  const regenerateBtn = document.getElementById("receiver-regenerate-btn")
  const openScreenBtn = document.getElementById("receiver-open-screen")
  const pairedList = document.getElementById("receiver-paired-list")
  const noDevicesEl = document.getElementById("receiver-no-devices")
  const screensaverHintRow = document.getElementById("settings-receiver-screensaver-hint")
  const screensaverOpenBtn = document.getElementById("settings-receiver-screensaver-open")

  let rawPairCode = ""
  let codeRevealed = false
  let receiverEnabled = false

  function syncSummaryLines(): void {
    const showStatus = receiverEnabled && !(card?.open ?? false)
    summaryHelper?.classList.toggle("hidden", showStatus)
    summaryStatus?.classList.toggle("hidden", !showStatus)
  }

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

  function renderPairCodeDisplay(): void {
    if (!pairCodeDisplay) return
    pairCodeDisplay.textContent = codeRevealed ? formatReceiverPairCode(rawPairCode) : MASKED_PAIR_CODE
    pairCodeDisplay.classList.toggle("text-accent", codeRevealed)
    pairCodeDisplay.classList.toggle("text-fg-3", !codeRevealed)
  }

  function setCodeRevealed(revealed: boolean): void {
    codeRevealed = revealed
    codeShowIcon?.classList.toggle("hidden", revealed)
    codeHideIcon?.classList.toggle("hidden", !revealed)
    codeRevealBtn?.setAttribute(
      "aria-label",
      t(revealed ? "settings.receiver.hideCode" : "settings.receiver.showCode")
    )
    renderPairCodeDisplay()
  }

  function renderAddresses(status: ReceiverStatus): void {
    if (!addressesList) return
    addressesList.replaceChildren()
    for (const ip of rankReceiverIps(status.ips ?? [])) {
      const address = formatReceiverAddress(ip, status.port)
      const addressBtn = document.createElement("button")
      addressBtn.type = "button"
      addressBtn.className = "btn min-h-9 px-2.5 py-1 text-sm tabular-nums gap-1.5"
      const addressLabel = document.createElement("span")
      addressLabel.textContent = address
      const copyGlyph = document.createElement("span")
      copyGlyph.className = "inline-flex text-xs text-fg-3"
      copyGlyph.innerHTML = ICON_COPY
      addressBtn.append(addressLabel, copyGlyph)
      addressBtn.title = t("settings.receiver.copyAddress")
      addressBtn.setAttribute("aria-label", t("settings.receiver.copyAddress"))
      addressBtn.addEventListener("click", () => {
        writeClipboardText(address)
          .then(() => toastSuccess(t("toast.copyOk")))
          .catch((err) => log.warn("[settings:receiver] clipboard write failed:", err))
      })
      addressesList.appendChild(addressBtn)
    }
    window.SpatialNavigation?.makeFocusable?.()
  }

  function renderPairedDevices(devices: ReceiverPairedDevice[]): void {
    if (!pairedList) return
    pairedList.replaceChildren()
    noDevicesEl?.classList.toggle("hidden", devices.length > 0)
    for (const device of devices) {
      const row = document.createElement("div")
      row.className = "flex w-full items-center gap-3 px-4 py-3"

      const textWrap = document.createElement("div")
      textWrap.className = "flex flex-1 flex-col min-w-0"
      const nameEl = document.createElement("span")
      nameEl.className = "truncate text-sm font-medium"
      nameEl.textContent = device.deviceName
      const dateEl = document.createElement("span")
      dateEl.className = "text-2xs text-fg-3"
      dateEl.textContent = t("settings.receiver.pairedOn", { date: new Date(device.createdAt).toLocaleDateString() })
      textWrap.append(nameEl, dateEl)

      const revokeBtn = document.createElement("button")
      revokeBtn.type = "button"
      revokeBtn.className = "btn flex-none"
      revokeBtn.textContent = t("settings.receiver.revoke")
      revokeBtn.addEventListener("click", () => void revokeDevice(device.key, device.deviceName))

      row.append(textWrap, revokeBtn)
      pairedList.appendChild(row)
    }
    window.SpatialNavigation?.makeFocusable?.()
  }

  function updateDeviceNamePlaceholder(status: ReceiverStatus): void {
    if (!deviceNameInput || deviceNameInput.value) return
    deviceNameInput.placeholder = status.name || t("settings.receiver.deviceNamePlaceholder")
  }

  // Android only; getAdvertiseState() returns null when the NSD bridge is unavailable (desktop).
  function renderDiscoverability(status: ReceiverStatus): void {
    if (!discoverableLine) return
    const state = status.enabled ? getAdvertiseState() : null
    if (state === "registered") {
      discoverableLine.textContent = t("settings.receiver.discoverableAs", { name: status.name })
      discoverableLine.classList.remove("hidden")
    } else if (state?.startsWith("failed")) {
      discoverableLine.textContent = t("settings.receiver.notDiscoverable")
      discoverableLine.classList.remove("hidden")
    } else {
      discoverableLine.classList.add("hidden")
    }
  }

  function renderStatus(status: ReceiverStatus): void {
    updateDeviceNamePlaceholder(status)

    const enabled = !!status.enabled
    statusBlock?.classList.toggle("hidden", !enabled)
    statusBlock?.classList.toggle("flex", enabled)

    liveBadge?.classList.toggle("hidden", !enabled)
    liveBadge?.classList.toggle("inline-flex", enabled)
    receiverEnabled = enabled
    if (summaryStatus) {
      summaryStatus.textContent = enabled
        ? t("settings.receiver.statusReceiving", { name: status.name })
        : ""
    }
    syncSummaryLines()

    renderDiscoverability(status)

    if (!enabled) return

    if (statusLineText) {
      statusLineText.textContent = t("settings.receiver.statusVisibleAs", { name: status.name })
    }

    renderAddresses(status)

    rawPairCode = status.pairCode ?? ""
    renderPairCodeDisplay()

    renderPairedDevices(status.pairedDevices ?? [])
  }

  async function refreshStatus(): Promise<void> {
    try {
      renderStatus(await invoke<ReceiverStatus>("receiver_status"))
    } catch (err) {
      log.warn("[settings:receiver] receiver_status failed:", err)
    }
  }

  async function revokeDevice(key: string, deviceName: string): Promise<void> {
    const confirmed = await confirmDialog({
      message: t("settings.receiver.revokeConfirm", { deviceName }),
      confirmLabel: t("settings.receiver.revoke"),
      destructive: true,
    })
    if (!confirmed) return
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
          startReceiverKeepAlive(status.name)
          if (status.port !== undefined) {
            advertiseReceiver(status.name, status.port, getReceiverId())
            setTimeout(() => renderDiscoverability(status), 1800)
          }
        })
        .catch((err) => {
          log.warn("[settings:receiver] receiver_start failed:", err)
          setReceiverModeEnabled(false)
          syncModeButtons()
          toastError(t("settings.receiver.startFailed"))
        })
    } else {
      invoke("receiver_stop")
        .then(refreshStatus)
        .then(stopAdvertisingReceiver)
        .then(stopReceiverKeepAlive)
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

  codeRevealBtn?.addEventListener("click", () => setCodeRevealed(!codeRevealed))

  regenerateBtn?.addEventListener("click", () => {
    invoke<ReceiverStatus>("receiver_regenerate_code")
      .then((status) => {
        renderStatus(status)
        toastSuccess(t("settings.receiver.regenerated"))
      })
      .catch((err) => log.warn("[settings:receiver] receiver_regenerate_code failed:", err))
  })

  openScreenBtn?.addEventListener("click", () => {
    location.href = "/receiver"
  })

  try {
    if ((window as any).AndroidScreensaver?.isDreamSettingsAvailable?.()) {
      screensaverHintRow?.classList.remove("hidden")
    }
  } catch {}
  screensaverOpenBtn?.addEventListener("click", () => {
    try {
      (window as any).AndroidScreensaver?.openDreamSettings?.()
    } catch (err) {
      log.warn("[settings:receiver] AndroidScreensaver.openDreamSettings failed:", err)
    }
  })

  if (deviceNameInput) {
    deviceNameInput.value = getReceiverDeviceName()
    const commitDeviceName = debounce((value: string) => {
      setReceiverDeviceName(value)
      if (!getReceiverModeEnabled()) return
      invoke<ReceiverStatus>("receiver_set_name", { name: value })
        .then((status) => {
          renderStatus(status)
          if (status.port !== undefined) {
            advertiseReceiver(status.name, status.port, getReceiverId())
            setTimeout(() => renderDiscoverability(status), 1800)
          }
        })
        .catch((err) => log.warn("[settings:receiver] receiver_set_name failed:", err))
    }, 600)
    deviceNameInput.addEventListener("input", () => commitDeviceName(deviceNameInput.value))
  }

  card?.addEventListener("toggle", syncSummaryLines)

  syncModeButtons()
  syncBootButtons()
  await refreshStatus()

  await listen<ReceiverStatus>("xt:receiver-status", (event) => renderStatus(event.payload))
  await listen("xt:receiver-paired", () => void refreshStatus())
}

void init()

export {}
