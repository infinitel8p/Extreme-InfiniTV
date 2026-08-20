// Settings card: paired "Play on TV" devices list, active session, and add-device entry point.
import { t } from "@/scripts/lib/i18n.js"
import { isTauri } from "@/scripts/lib/creds.js"
import { fmtAge } from "@/scripts/lib/format.js"
import { log } from "@/scripts/lib/log.js"
import { confirmDialog } from "@/scripts/lib/confirm-dialog.js"
import {
  listTvDevices,
  removeTvDevice,
  probeTvDeviceAuthorized,
  getCastSession,
  sessionAsDevice,
  castStop,
  CAST_SESSION_EVENT,
  TV_DEVICES_EVENT,
  type TvDevice,
} from "@/scripts/lib/tv-cast.js"
import { openTvDevicePicker } from "@/scripts/lib/tv-device-dialog.js"

const HOLLOW_DOT_CLASS = "size-1.5 rounded-full border border-fg-3"

function init(): void {
  if (!isTauri) return

  const card = document.getElementById("card-play-on-tv") as HTMLDetailsElement | null
  card?.classList.remove("hidden")
  document.getElementById("card-casting")?.classList.remove("hidden")

  const listEl = document.getElementById("play-on-tv-list")
  const emptyEl = document.getElementById("play-on-tv-empty")
  const addBtn = document.getElementById("play-on-tv-add")
  const liveBadge = document.getElementById("play-on-tv-live-badge")
  const summaryHelper = document.getElementById("play-on-tv-summary-helper")
  const summaryStatus = document.getElementById("play-on-tv-summary-status")
  const sessionBlock = document.getElementById("play-on-tv-session")
  const sessionLine = document.getElementById("play-on-tv-session-line")
  const sessionTitle = document.getElementById("play-on-tv-session-title")
  const stopBtn = document.getElementById("play-on-tv-stop")

  const rowsByDeviceId = new Map<string, HTMLElement>()
  let probeGeneration = 0

  function renderSession(): void {
    const session = getCastSession()

    liveBadge?.classList.toggle("hidden", !session)
    liveBadge?.classList.toggle("inline-flex", !!session)
    summaryHelper?.classList.toggle("hidden", !!session)
    summaryStatus?.classList.toggle("hidden", !session)
    if (summaryStatus) {
      summaryStatus.textContent = session
        ? t("settings.playOnTv.castingTo", { device: session.deviceName })
        : ""
    }

    sessionBlock?.classList.toggle("hidden", !session)
    sessionBlock?.classList.toggle("flex", !!session)
    if (!session) return

    if (sessionLine) {
      sessionLine.textContent = session.title
        ? t("settings.playOnTv.castingTo", { device: session.deviceName })
        : t("settings.playOnTv.connectedTo", { device: session.deviceName })
    }
    if (sessionTitle) {
      sessionTitle.textContent = session.title
      sessionTitle.classList.toggle("hidden", !session.title)
    }
  }

  function applyRowStatus(
    statusEl: HTMLElement,
    kind: "checking" | "online" | "unauthorized" | "unreachable"
  ): void {
    statusEl.replaceChildren()
    const dot = document.createElement("span")
    const label = document.createElement("span")
    switch (kind) {
      case "online":
        dot.className = "size-1.5 rounded-full bg-ok"
        label.textContent = t("settings.playOnTv.online")
        break
      case "unauthorized":
        dot.className = "size-1.5 rounded-full bg-warn"
        label.textContent = t("settings.playOnTv.needsPairing")
        break
      case "unreachable":
        dot.className = HOLLOW_DOT_CLASS
        label.textContent = t("settings.playOnTv.offline")
        break
      default:
        dot.className = HOLLOW_DOT_CLASS
        label.textContent = t("settings.playOnTv.checking")
        break
    }
    statusEl.append(dot, label)
  }

  async function removeDevice(device: TvDevice): Promise<void> {
    const confirmed = await confirmDialog({
      message: t("settings.playOnTv.removeConfirm", { name: device.name }),
      confirmLabel: t("settings.playOnTv.remove"),
      destructive: true,
    })
    if (!confirmed) return
    removeTvDevice(device.id)
  }

  function renderRow(device: TvDevice): HTMLDivElement {
    const row = document.createElement("div")
    row.className = "flex w-full items-center gap-3 px-4 py-3"

    const textColumn = document.createElement("div")
    textColumn.className = "flex flex-1 flex-col min-w-0"

    const nameEl = document.createElement("span")
    nameEl.className = "truncate text-sm font-medium"
    nameEl.textContent = device.name
    textColumn.appendChild(nameEl)

    const metaRow = document.createElement("span")
    metaRow.className = "text-2xs text-fg-3 flex flex-wrap items-center gap-x-2 gap-y-0.5"

    const hostPortEl = document.createElement("span")
    hostPortEl.className = "tabular-nums whitespace-nowrap"
    hostPortEl.textContent = `${device.host}:${device.port}`
    metaRow.appendChild(hostPortEl)

    const lastUsedAge = fmtAge(device.lastSeenAt)
    if (lastUsedAge) {
      const lastUsedEl = document.createElement("span")
      lastUsedEl.className = "whitespace-nowrap"
      lastUsedEl.textContent = t("cast.picker.lastUsed", { when: lastUsedAge })
      metaRow.appendChild(lastUsedEl)
    }

    const statusEl = document.createElement("span")
    statusEl.dataset.role = "status"
    statusEl.className = "flex items-center gap-1.5 whitespace-nowrap"
    applyRowStatus(statusEl, "checking")
    metaRow.appendChild(statusEl)

    textColumn.appendChild(metaRow)

    const removeBtn = document.createElement("button")
    removeBtn.type = "button"
    removeBtn.className = "btn flex-none"
    removeBtn.textContent = t("settings.playOnTv.remove")
    removeBtn.addEventListener("click", () => void removeDevice(device))

    row.append(textColumn, removeBtn)
    return row
  }

  function renderDevices(): void {
    if (!listEl) return
    const devices = [...listTvDevices()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    rowsByDeviceId.clear()
    listEl.replaceChildren()
    for (const device of devices) {
      const row = renderRow(device)
      rowsByDeviceId.set(device.id, row)
      listEl.appendChild(row)
    }
    listEl.classList.toggle("hidden", devices.length === 0)
    emptyEl?.classList.toggle("hidden", devices.length > 0)
    window.SpatialNavigation?.makeFocusable?.()
  }

  async function probeAll(): Promise<void> {
    const generation = ++probeGeneration
    await Promise.all(
      listTvDevices().map(async (device) => {
        const row = rowsByDeviceId.get(device.id)
        const statusEl = row?.querySelector<HTMLElement>('[data-role="status"]')
        if (!statusEl) return
        const result = await probeTvDeviceAuthorized(device)
        if (generation !== probeGeneration) return
        applyRowStatus(statusEl, result)
      })
    )
  }

  card?.addEventListener("toggle", () => {
    if (card.open) void probeAll()
  })

  addBtn?.addEventListener("click", () => {
    void openTvDevicePicker({ mode: "add" }).then((device) => {
      if (!device) return
      renderDevices()
      void probeAll()
    })
  })

  stopBtn?.addEventListener("click", () => {
    const session = getCastSession()
    if (!session) return
    castStop(sessionAsDevice(session)).catch(log.warn)
  })

  document.addEventListener(TV_DEVICES_EVENT, () => {
    renderDevices()
    if (card?.open) void probeAll()
  })
  document.addEventListener(CAST_SESSION_EVENT, renderSession)

  renderDevices()
  renderSession()
}

init()

export {}
