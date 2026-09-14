// Flat D-pad playlist row for the TV dialogs: select button plus a "more" button opening an action sheet.

import { navigate } from "astro:transitions/client"
import { t } from "@/scripts/lib/i18n"
import { selectEntry, removeEntry, getActiveEntry, entryToCreds } from "@/scripts/lib/creds.js"
import { getNewestCacheTime } from "@/scripts/lib/cache.js"
import { fmtAge } from "@/scripts/lib/format.ts"
import { ICON_CHECK, ICON_DOTS, ICON_X } from "@/scripts/lib/icons"
import { confirmDialog } from "@/scripts/lib/confirm-dialog"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav"
import { redactUrl } from "@/scripts/lib/log"
import { toastSuccess, toastWarn } from "@/scripts/lib/toast"
import { classifyError, describeClassifiedError } from "@/scripts/lib/provider-error.js"
import {
  getPlaylistHealth,
  refreshPlaylistHealth,
  fmtAgo,
  fmtAbsDate,
  type AccountStatus,
  type PlaylistHealth,
} from "@/scripts/lib/playlist-health.ts"
import { exportEntryM3U, resolveSampleStreamUrl } from "@/scripts/lib/playlist-rows.js"
import type { ActionSheetHandle, ActionSheetItem, ActionSheetFact } from "@/scripts/tv/ui/action-sheet.ts"

export interface TvPlaylistRowOptions {
  entry: any
  isActive: boolean
  onAfterSelect: () => void | Promise<void>
  onAfterChange: (changedEntryId: string, change: "refresh" | "remove") => void | Promise<void>
  actionSheet: ActionSheetHandle
  /** Called before navigating away for "Edit" so the caller can close its own dialog first. */
  onBeforeNavigate?: () => void
}

function playlistBadgeLabel(entry: any): string {
  if (entry.type === "xtream") return "XT"
  if (entry.type === "local-m3u") return "FILE"
  if (entry.type === "custom") return "CUST"
  return "M3U"
}

function accountStatusLabel(status: AccountStatus): string {
  if (status === "active") return t("settings.health.accountActive")
  if (status === "expired") return t("settings.health.accountExpired")
  if (status === "inactive") return t("settings.health.accountInactive")
  return t("settings.health.accountUnknown")
}

function expiryLabel(account: PlaylistHealth["account"]): string {
  const date = fmtAbsDate(account.expDateMs)
  const days = account.daysUntilExpiry
  if (days != null && days < 0) return t("settings.health.expiredOn", { date })
  if (days != null) return t("settings.health.expiresInDays", { days, date })
  return date
}

function buildSecondaryText(entry: any): string {
  const health = getPlaylistHealth(entry._id)
  if (health.account.status !== "unknown") return accountStatusLabel(health.account.status)
  if (health.account.expDateMs) return expiryLabel(health.account)
  const ageLabel = fmtAge(getNewestCacheTime(entry._id))
  return ageLabel ? t("playlist.updatedAgo", { age: ageLabel }) : t("playlist.notLoaded")
}

function fmtCount(value: number | null): string {
  return Number.isFinite(value) ? Number(value).toLocaleString() : "-"
}

/** One fact per row, matching the settings.health.* wording and tone rules used by the desktop health panel. */
function buildHealthFacts(entry: any): ActionSheetFact[] {
  const health = getPlaylistHealth(entry._id)
  const facts: ActionSheetFact[] = []

  if (health.account.status !== "unknown") {
    const tone =
      health.account.status === "active"
        ? "good"
        : health.account.status === "expired"
        ? "bad"
        : health.account.status === "inactive"
        ? "warn"
        : "neutral"
    facts.push({ label: t("settings.health.account"), value: accountStatusLabel(health.account.status), tone })
  }
  if (health.account.activeConnections != null && health.account.maxConnections != null) {
    const tone = health.account.activeConnections >= health.account.maxConnections ? "warn" : "neutral"
    facts.push({
      label: t("settings.health.connections"),
      value: `${health.account.activeConnections} / ${health.account.maxConnections}`,
      tone,
    })
  }
  if (health.account.expDateMs) {
    const days = health.account.daysUntilExpiry
    const tone = days != null && days < 0 ? "bad" : days != null && days <= 7 ? "warn" : days != null ? "good" : "neutral"
    facts.push({ label: t("settings.health.expiry"), value: expiryLabel(health.account), tone })
  }
  if (health.catalog.live.fetchedAt) {
    facts.push({
      label: t("settings.health.live"),
      value: `${fmtCount(health.catalog.live.itemCount)} · ${fmtAgo(health.catalog.live.fetchedAt)}`,
      tone: "neutral",
    })
  }
  if (health.catalog.vod.fetchedAt) {
    facts.push({
      label: t("settings.health.vod"),
      value: `${fmtCount(health.catalog.vod.itemCount)} · ${fmtAgo(health.catalog.vod.fetchedAt)}`,
      tone: "neutral",
    })
  }
  if (health.catalog.series.fetchedAt) {
    facts.push({
      label: t("settings.health.series"),
      value: `${fmtCount(health.catalog.series.itemCount)} · ${fmtAgo(health.catalog.series.fetchedAt)}`,
      tone: "neutral",
    })
  }
  if (health.epg.fetchedAt) {
    facts.push({
      label: t("settings.health.epg"),
      value: `${fmtCount(health.epg.channelsWithProgrammes)} · ${fmtAgo(health.epg.fetchedAt)}`,
      tone: "neutral",
    })
  }

  return facts
}

async function refreshEntryData(
  entry: any,
  onAfterChange: TvPlaylistRowOptions["onAfterChange"]
): Promise<void> {
  try {
    const creds = entryToCreds(entry)
    await refreshPlaylistHealth(entry._id, creds)
    toastSuccess(t("playlist.toast.refreshed", { title: entry.title }))
  } catch {
    toastWarn(t("playlist.toast.refreshFailed", { title: entry.title }))
  } finally {
    await onAfterChange(entry._id, "refresh")
  }
}

async function deleteEntry(entry: any, onAfterChange: TvPlaylistRowOptions["onAfterChange"]): Promise<void> {
  const active = await getActiveEntry()
  const message =
    (active?._id === entry._id ? t("playlist.removeConfirmActive") + "\n" : "") +
    t("playlist.removeConfirm", { title: entry.title }) +
    "\n" +
    t("playlist.removeConfirmDetail")
  const ok = await confirmDialog({
    title: t("playlist.removeAria", { title: entry.title }),
    message,
    confirmLabel: t("common.remove"),
    destructive: true,
  })
  if (!ok) return
  await removeEntry(entry._id)
  await onAfterChange(entry._id, "remove")
}

let diagnosticDialogEl: HTMLDialogElement | null = null

function ensureDiagnosticDialog(): HTMLDialogElement {
  if (diagnosticDialogEl?.isConnected) return diagnosticDialogEl
  const dialog = document.createElement("dialog")
  dialog.id = "tv-playlist-diagnostic-dialog"
  dialog.className =
    "m-auto w-[22rem] max-w-[90vw] rounded-2xl border border-line bg-surface p-0 text-fg backdrop:bg-black/70"
  dialog.innerHTML = `
    <div class="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
      <h2 data-role="title" class="min-w-0 flex-1 truncate text-base font-semibold"></h2>
      <button type="button" data-role="close" class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-3 outline-none tv-focus-inset hover:bg-surface-2 hover:text-fg" aria-label="${t("common.close")}">
        <span class="inline-flex text-base">${ICON_X}</span>
      </button>
    </div>
    <div data-role="body" role="status" aria-live="polite" class="max-h-[60vh] overflow-y-auto p-4"></div>
  `
  document.body.appendChild(dialog)
  dialog.querySelector('[data-role="close"]')?.addEventListener("click", () => dialog.close())
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close()
  })
  attachDialogSpatialNav(dialog)
  diagnosticDialogEl = dialog
  return dialog
}

async function runDiagnosticForEntry(entry: any): Promise<void> {
  const dialog = ensureDiagnosticDialog()
  const titleEl = dialog.querySelector<HTMLElement>('[data-role="title"]')
  const bodyEl = dialog.querySelector<HTMLElement>('[data-role="body"]')
  if (titleEl) titleEl.textContent = entry.title
  if (bodyEl) {
    bodyEl.replaceChildren()
    const status = document.createElement("p")
    status.className = "text-sm text-fg-2"
    status.textContent = t("login.status.testing")
    bodyEl.appendChild(status)
  }
  if (typeof dialog.showModal === "function") dialog.showModal()

  try {
    const { runXtreamDiagnostic, runM3UDiagnostic, renderDiagnosticInto } = await import(
      "@/scripts/lib/diagnostic.ts"
    )
    const runOptions = {
      entry: {
        epgUrl: entry.epgUrl,
        additionalEpgUrls: entry.additionalEpgUrls,
        disableProviderEpg: entry.disableProviderEpg,
        liveContainer: entry.liveContainer,
        type: entry.type,
        dns: entry.dns,
      },
      sampleStreamUrl: resolveSampleStreamUrl(entry) || undefined,
    }
    const result =
      entry.type === "xtream"
        ? await runXtreamDiagnostic(
            { serverUrl: entry.serverUrl, username: entry.username, password: entry.password },
            runOptions
          )
        : await runM3UDiagnostic(entry.url, runOptions)
    if (bodyEl) renderDiagnosticInto(bodyEl, result)
  } catch (error) {
    if (bodyEl) {
      bodyEl.replaceChildren()
      const classified = classifyError({ error })
      const message = document.createElement("p")
      message.className = "text-sm text-fg-2"
      message.textContent = describeClassifiedError(classified)
      const technical = document.createElement("p")
      technical.className = "mt-1 text-2xs text-fg-3"
      technical.textContent = redactUrl((error as Error)?.message || String(error))
      bodyEl.append(message, technical)
    }
  }
}

function buildActions(opts: TvPlaylistRowOptions): ActionSheetItem[] {
  const { entry, onAfterChange, onBeforeNavigate } = opts
  const actions: ActionSheetItem[] = []
  const isRemote = entry.type === "xtream" || entry.type === "m3u"

  if (isRemote) {
    actions.push({
      label: t("settings.health.refresh"),
      onSelect: () => void refreshEntryData(entry, onAfterChange),
    })
    actions.push({
      label: t("diagnostic.runFull"),
      onSelect: () => void runDiagnosticForEntry(entry),
    })
  }

  actions.push({
    label: t("common.edit"),
    onSelect: () => {
      onBeforeNavigate?.()
      void navigate(`/tv/login?edit=${encodeURIComponent(entry._id)}`)
    },
  })

  actions.push({
    label: t("editor.exportM3uAction"),
    onSelect: () => void exportEntryM3U(entry),
  })

  actions.push({
    label: t("common.remove"),
    destructive: true,
    onSelect: () => void deleteEntry(entry, onAfterChange),
  })

  return actions
}

export function renderTvPlaylistRow(opts: TvPlaylistRowOptions): HTMLElement {
  const { entry, isActive, onAfterSelect, actionSheet } = opts

  const row = document.createElement("div")
  row.className = "flex items-center gap-2"
  row.dataset.entryId = entry._id

  const mainButton = document.createElement("button")
  mainButton.type = "button"
  mainButton.className =
    "flex-1 min-h-14 flex items-center gap-3 rounded-xl px-4 text-start outline-none hover:bg-surface-2 tv-focus-inset"
  mainButton.dataset.role = "main"
  if (isActive) mainButton.dataset.tvRowActive = "true"

  const badge = document.createElement("span")
  badge.className =
    "inline-flex h-6 min-w-12 shrink-0 items-center justify-center rounded-md px-2 text-label font-semibold uppercase tracking-wide ring-1 ring-line text-fg-2 bg-surface-2"
  badge.textContent = playlistBadgeLabel(entry)

  const textWrap = document.createElement("span")
  textWrap.className = "flex min-w-0 flex-1 flex-col gap-0.5"

  const titleEl = document.createElement("span")
  titleEl.className = `truncate text-sm ${isActive ? "text-fg font-medium" : "text-fg-2"}`
  titleEl.textContent = entry.title

  const secondaryEl = document.createElement("span")
  secondaryEl.className = "truncate text-2xs text-fg-3"
  secondaryEl.textContent = buildSecondaryText(entry)

  textWrap.append(titleEl, secondaryEl)
  mainButton.append(badge, textWrap)

  if (isActive) {
    const check = document.createElement("span")
    check.className = "check-draw text-accent shrink-0 inline-flex text-sm"
    check.innerHTML = ICON_CHECK
    mainButton.appendChild(check)
  }

  function openActionSheet(): void {
    actionSheet.open(entry.title, buildActions(opts), { facts: buildHealthFacts(entry) })
  }

  mainButton.addEventListener("click", async () => {
    await selectEntry(entry._id)
    await onAfterSelect()
  })
  mainButton.addEventListener("contextmenu", (event) => {
    event.preventDefault()
    openActionSheet()
  })
  mainButton.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu") return
    event.preventDefault()
    openActionSheet()
  })

  const moreButton = document.createElement("button")
  moreButton.type = "button"
  moreButton.className =
    "inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-fg-3 outline-none hover:bg-surface-2 tv-focus-inset"
  moreButton.setAttribute("aria-label", t("common.moreOptionsAria", { title: entry.title }))
  moreButton.innerHTML = `<span class="inline-flex text-base">${ICON_DOTS}</span>`
  moreButton.addEventListener("click", () => openActionSheet())

  row.append(mainButton, moreButton)
  return row
}
