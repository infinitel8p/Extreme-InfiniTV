// Lazy-mounted "Stream health" dialog: playback sessions + their event log.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import {
  listHealthSessions,
  subscribeHealth,
  summarizeSession,
  formatEntryOffset,
  type HealthSession,
  type HealthEntry,
} from "@/scripts/lib/stream-health.js"
import { formatPaddedHms } from "@/scripts/lib/format.js"
import { kindLabel } from "@/scripts/lib/kinds.js"
import { t } from "@/scripts/lib/i18n.js"
import { writeClipboardText } from "@/scripts/lib/clipboard.js"
import { log } from "@/scripts/lib/log.js"
import { ICON_CHEVRON_DOWN } from "@/scripts/lib/icons.js"

const DIALOG_ID = "stream-health-dialog"

let dialogEl: HTMLDialogElement | null = null
let listEl: HTMLElement | null = null
let copyBtn: HTMLButtonElement | null = null
let closeBtn: HTMLButtonElement | null = null
let unsubscribeHealth: (() => void) | null = null
let pendingFrame: number | null = null
let emptyMessageEl: HTMLParagraphElement | null = null

// Reused across repaints, keyed by the stable session id, so a live update
// never drops an expanded <details> or steals focus off its <summary>.
const sessionNodesById = new Map<number, HTMLDetailsElement>()

function formatDuration(ms: number): string {
  return formatPaddedHms(Math.max(0, Math.round(ms / 1000)))
}

function buildEntryItem(session: HealthSession, entry: HealthEntry): HTMLLIElement {
  const item = document.createElement("li")
  item.className = "flex items-baseline gap-2 py-1 text-sm"

  const offsetEl = document.createElement("span")
  offsetEl.className = "tabular-nums text-fg-3 text-2xs shrink-0"
  offsetEl.textContent = formatEntryOffset(entry.at, session.startedAt)
  item.appendChild(offsetEl)

  const kindEl = document.createElement("span")
  kindEl.className = "font-medium text-fg shrink-0"
  kindEl.textContent = t(`stream.health.kind.${entry.kind}`)
  item.appendChild(kindEl)

  if (entry.detail) {
    const detailEl = document.createElement("span")
    detailEl.className = "text-fg-2 truncate"
    detailEl.textContent = entry.detail
    item.appendChild(detailEl)
  }

  if (entry.count > 1) {
    const repeatEl = document.createElement("span")
    repeatEl.className = "text-fg-3 text-2xs tabular-nums ml-auto shrink-0"
    repeatEl.textContent = t("stream.health.repeat", { count: entry.count })
    item.appendChild(repeatEl)
  }

  return item
}

function fillEntryList(entryList: HTMLUListElement, session: HealthSession): void {
  entryList.textContent = ""
  if (session.entries.length === 0) {
    const placeholder = document.createElement("li")
    placeholder.className = "py-1 text-sm text-fg-3"
    placeholder.textContent = t("stream.health.empty")
    entryList.appendChild(placeholder)
    return
  }
  for (const entry of session.entries) entryList.appendChild(buildEntryItem(session, entry))
}

// Only ever mutates textContent of the existing label/meta/counts spans -
// never clears/rebuilds the <summary> itself, so a repaint while it's the
// focused element (its own children momentarily removed) can't blur it.
function fillSessionSummary(summaryEl: HTMLElement, session: HealthSession): void {
  const summary = summarizeSession(session)

  const labelEl = summaryEl.querySelector<HTMLElement>('[data-role="session-label"]')
  if (labelEl) labelEl.textContent = session.label

  const metaEl = summaryEl.querySelector<HTMLElement>('[data-role="session-meta"]')
  if (metaEl) {
    metaEl.textContent = t("stream.health.sessionMeta", {
      kind: kindLabel(session.kind),
      backend: session.backend,
    })
  }

  const countsEl = summaryEl.querySelector<HTMLElement>('[data-role="session-counts"]')
  if (countsEl) {
    countsEl.textContent = t("stream.health.summary", {
      variants: summary.variants,
      stalls: summary.stalls,
      waits: summary.waits,
      errors: summary.errors,
      dropped: summary.droppedFrames,
      duration: formatDuration(summary.durationMs),
    })
  }
}

function updateSessionDetails(details: HTMLDetailsElement, session: HealthSession): void {
  const summaryEl = details.querySelector<HTMLElement>("summary")
  const entryList = details.querySelector<HTMLUListElement>("ul")
  if (summaryEl) fillSessionSummary(summaryEl, session)
  if (entryList) fillEntryList(entryList, session)
}

function buildSessionDetails(session: HealthSession): HTMLDetailsElement {
  const details = document.createElement("details")
  details.className = "rounded-xl border border-line bg-bg"

  const summaryEl = document.createElement("summary")
  summaryEl.className =
    "min-h-11 cursor-pointer select-none list-none px-3 py-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5"

  const labelEl = document.createElement("span")
  labelEl.dataset.role = "session-label"
  labelEl.className = "font-medium text-fg text-sm"
  summaryEl.appendChild(labelEl)

  const metaEl = document.createElement("span")
  metaEl.dataset.role = "session-meta"
  metaEl.className = "text-fg-3 text-2xs"
  summaryEl.appendChild(metaEl)

  const countsEl = document.createElement("span")
  countsEl.dataset.role = "session-counts"
  countsEl.className = "ml-auto text-fg-3 text-2xs tabular-nums"
  summaryEl.appendChild(countsEl)

  const chevronEl = document.createElement("span")
  chevronEl.className =
    "self-center shrink-0 size-4 text-fg-3 changelog-chevron transition-transform duration-200"
  chevronEl.setAttribute("aria-hidden", "true")
  chevronEl.innerHTML = ICON_CHEVRON_DOWN
  summaryEl.appendChild(chevronEl)

  details.appendChild(summaryEl)

  const entryList = document.createElement("ul")
  entryList.className = "flex flex-col divide-y divide-line/60 px-3 pb-2"
  details.appendChild(entryList)

  updateSessionDetails(details, session)
  return details
}

// Drops a session node; if focus was inside it, falls back to the close
// button rather than letting it fall through to <body>.
function removeSessionNode(id: number): void {
  const node = sessionNodesById.get(id)
  if (!node) return
  sessionNodesById.delete(id)
  if (node.contains(document.activeElement)) closeBtn?.focus({ preventScroll: true })
  node.remove()
}

function paint(): void {
  const node = ensureDialog()
  const titleEl = node.querySelector<HTMLElement>('[data-role="title"]')
  if (titleEl) titleEl.textContent = t("stream.health.title")
  if (closeBtn) closeBtn.textContent = t("common.close")
  if (copyBtn) copyBtn.textContent = t("stream.health.copy")

  if (!listEl) return
  const sessions = listHealthSessions()

  if (sessions.length === 0) {
    for (const id of [...sessionNodesById.keys()]) removeSessionNode(id)
    if (!emptyMessageEl) {
      emptyMessageEl = document.createElement("p")
      emptyMessageEl.className = "text-sm text-fg-3 text-center py-10"
      listEl.appendChild(emptyMessageEl)
    }
    emptyMessageEl.textContent = t("stream.health.empty")
    return
  }

  if (emptyMessageEl) {
    emptyMessageEl.remove()
    emptyMessageEl = null
  }

  const seenIds = new Set<number>()
  let addedNode = false
  let index = 0
  for (const session of sessions) {
    seenIds.add(session.id)
    let sessionNode = sessionNodesById.get(session.id)
    if (!sessionNode) {
      sessionNode = buildSessionDetails(session)
      sessionNodesById.set(session.id, sessionNode)
      addedNode = true
    } else {
      updateSessionDetails(sessionNode, session)
    }
    // insertBefore/appendChild disconnect+reconnect a node even when it's
    // already in the right spot, which blurs a focused descendant - only
    // touch the ones that actually need to move.
    if (listEl.children[index] !== sessionNode) listEl.insertBefore(sessionNode, listEl.children[index] ?? null)
    index++
  }

  for (const id of [...sessionNodesById.keys()]) {
    if (!seenIds.has(id)) removeSessionNode(id)
  }

  if (addedNode) window.SpatialNavigation?.makeFocusable?.()
}

async function handleCopy(): Promise<void> {
  if (!copyBtn) return
  try {
    await writeClipboardText(JSON.stringify(listHealthSessions(), null, 2))
    copyBtn.textContent = t("stream.health.copied")
    setTimeout(() => {
      if (copyBtn) copyBtn.textContent = t("stream.health.copy")
    }, 1400)
  } catch (error) {
    log.warn("[xt:stream-health] copy failed:", error)
  }
}

function scheduleRepaint(): void {
  if (pendingFrame != null) return
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null
    paint()
  })
}

function stopLiveUpdates(): void {
  unsubscribeHealth?.()
  unsubscribeHealth = null
  if (pendingFrame != null) {
    cancelAnimationFrame(pendingFrame)
    pendingFrame = null
  }
}

function ensureDialog(): HTMLDialogElement {
  if (dialogEl) return dialogEl

  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(34rem,calc(100vw-2rem))] max-h-[min(80dvh,40rem)]",
    "open:flex flex-col overflow-hidden",
    "backdrop:bg-black/60",
  ].join(" ")
  node.innerHTML = `
    <div class="flex flex-col flex-auto min-h-0 gap-3 p-5 sm:p-6">
      <header class="flex items-start justify-between gap-3 shrink-0">
        <h2 id="${DIALOG_ID}-title" data-role="title" class="text-base font-semibold"></h2>
        <button
          type="button"
          data-role="close"
          class="rounded-lg border border-line min-h-11 px-3 py-1.5 text-xs text-fg-2 shrink-0
                 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent"></button>
      </header>
      <div data-role="list" class="flex flex-col gap-2 overflow-y-auto custom-scroll min-h-0"></div>
      <footer class="flex items-center gap-2 pt-1 shrink-0">
        <button type="button" data-role="copy" class="btn"></button>
      </footer>
    </div>
  `
  document.body.appendChild(node)
  attachDialogSpatialNav(node)

  node.addEventListener("click", (event) => {
    if (event.target === node) node.close()
  })
  node.querySelector('[data-role="close"]')?.addEventListener("click", () => node.close())
  node.addEventListener("close", stopLiveUpdates)

  dialogEl = node
  listEl = node.querySelector('[data-role="list"]')
  copyBtn = node.querySelector<HTMLButtonElement>('[data-role="copy"]')
  closeBtn = node.querySelector<HTMLButtonElement>('[data-role="close"]')
  copyBtn?.addEventListener("click", () => void handleCopy())
  return node
}

export function openStreamHealthDialog(): void {
  const node = ensureDialog()
  paint()
  if (!unsubscribeHealth) unsubscribeHealth = subscribeHealth(scheduleRepaint)
  if (!node.open) {
    if (typeof node.showModal === "function") node.showModal()
    else node.setAttribute("open", "")
  }
  requestAnimationFrame(() => {
    node.querySelector<HTMLElement>('[data-role="close"]')?.focus?.({ preventScroll: true })
  })
}
