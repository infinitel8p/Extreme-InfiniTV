// Downloads: one vertical list of active + finished downloads, action sheet for pause/resume/retry/remove.
import type { TvView, TvViewContext } from "@/scripts/tv/router"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n"
import { registerFocusSection, keepFocusedInView, remPx } from "@/scripts/tv/focus"
import {
  listDownloads,
  pauseDownload,
  resumeDownload,
  removeDownload,
  getRowThroughputEwma,
  DOWNLOADS_LIST_EVENT,
  DOWNLOAD_PROGRESS_EVENT,
  THROUGHPUT_EVENT,
} from "@/scripts/lib/downloads.js"
import { playDownloadedItem, type DownloadItem } from "@/scripts/tv/playback-local"
import { isAndroidFsActive, prettifyAndroidUri } from "@/scripts/lib/android-fs.js"
import { getDownloadDir } from "@/scripts/lib/app-settings.js"
import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { confirmDialog } from "@/scripts/lib/confirm-dialog.ts"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.ts"
import { ICON_X, ICON_DOTS } from "@/scripts/lib/icons.ts"

const SKELETON_ROW_COUNT = 4
const REPAINT_THROTTLE_MS = 250
const LIST_KEEP_IN_VIEW_REM = 8.75

function statusSortOrder(status: string): number {
  switch (status) {
    case "downloading": return 0
    case "stalled": return 1
    case "queued": return 2
    case "paused": return 3
    case "error": return 4
    case "done": return 5
    default: return 6
  }
}

function orderedItems(items: DownloadItem[]): DownloadItem[] {
  const active = items
    .filter((item) => item.status !== "done" && item.status !== "cancelled")
    .sort((a, b) => statusSortOrder(a.status) - statusSortOrder(b.status))
  const done = items
    .filter((item) => item.status === "done")
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return [...active, ...done]
}

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || !isFinite(bytesPerSec) || bytesPerSec <= 0) return ""
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`
}

function formatBytes(n: number): string {
  if (!n || n < 0) return "0 B"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function subtitleFor(item: DownloadItem): string {
  const source = item.source
  if (source?.kind !== "episode") return ""
  const seasonLabel = source.season != null ? `S${source.season}` : ""
  const episodeLabel = source.episode != null ? `E${source.episode}` : ""
  const tag = seasonLabel + episodeLabel
  if (source.seriesName && tag) return `${source.seriesName} · ${tag}`
  return source.seriesName || tag
}

function statusLine(item: DownloadItem): string {
  const label = t(`downloads.status.${item.status}`) || item.status
  if (item.status === "downloading") {
    const bits = [label]
    if (item.bytesTotal && item.bytesTotal > 0) {
      const percent = Math.round(((item.bytesDone || 0) / item.bytesTotal) * 100)
      bits[0] = `${label} ${percent}%`
    }
    const speed = formatSpeed(getRowThroughputEwma(item.id))
    if (speed) bits.push(speed)
    return bits.join(" · ")
  }
  if (item.status === "done") {
    return item.bytesTotal && item.bytesTotal > 0 ? `${label} · ${formatBytes(item.bytesTotal)}` : label
  }
  if (item.status === "error" && item.error) return `${label} · ${item.error}`
  return label
}

function progressFraction(item: DownloadItem): number | null {
  if (!item.bytesTotal || item.bytesTotal <= 0) return null
  return Math.max(0, Math.min(1, (item.bytesDone || 0) / item.bytesTotal))
}

function buildThumb(logoUrl: string | null | undefined): HTMLSpanElement {
  const box = document.createElement("span")
  box.setAttribute("aria-hidden", "true")
  box.className =
    "grid isolate aspect-video h-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-black/40 ring-1 ring-inset ring-line"
  if (logoUrl) {
    const img = document.createElement("img")
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    img.referrerPolicy = "no-referrer"
    img.className = "h-full w-full min-h-0 min-w-0 object-contain"
    mountCachedImage(img, logoUrl, "poster")
    box.appendChild(img)
  }
  return box
}

function buildSkeletonRow(): HTMLDivElement {
  const row = document.createElement("div")
  row.setAttribute("aria-hidden", "true")
  row.className = "flex min-h-[3.5rem] items-center gap-4 rounded-xl px-3 py-2"
  const thumb = document.createElement("span")
  thumb.className = "aspect-video h-12 shrink-0 animate-pulse rounded-lg bg-surface-2"
  const text = document.createElement("span")
  text.className = "flex min-w-0 flex-1 flex-col gap-2"
  const line1 = document.createElement("span")
  line1.className = "h-3 w-1/2 animate-pulse rounded bg-surface-2"
  const line2 = document.createElement("span")
  line2.className = "h-2.5 w-1/3 animate-pulse rounded bg-surface-2"
  text.append(line1, line2)
  row.append(thumb, text)
  return row
}

interface RowRefs {
  el: HTMLDivElement
  playButton: HTMLButtonElement
  menuButton: HTMLButtonElement | null
  thumbSlot: HTMLElement
  thumbImg: HTMLImageElement | null
  titleEl: HTMLElement
  subtitleEl: HTMLElement
  statusEl: HTMLElement
  barShell: HTMLElement
  barFill: HTMLElement
  logoUrl: string | null
  status: string
}

const view: TvView = {
  mount(root: HTMLElement, _ctx: TvViewContext) {
    let destroyed = false
    let items: DownloadItem[] = []
    const rowsById = new Map<string, RowRefs>()
    const unsubs: Array<() => void> = []

    let listEl: HTMLElement | null = null
    let scrollerEl: HTMLElement | null = null
    let emptyEl: HTMLElement | null = null
    let countEl: HTMLElement | null = null
    let folderEl: HTMLElement | null = null
    let actionDialog: HTMLDialogElement | null = null

    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let pendingFullRefresh = false

    function scheduleRefresh(): void {
      pendingFullRefresh = true
      if (flushTimer != null) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        if (destroyed) return
        if (pendingFullRefresh) {
          pendingFullRefresh = false
          renderRows()
        }
      }, REPAINT_THROTTLE_MS)
    }

    function folderLabel(): string {
      if (isAndroidFsActive()) {
        const dir = getDownloadDir()
        return dir ? prettifyAndroidUri(dir) : t("tv.downloads.defaultFolder")
      }
      return getDownloadDir() || ""
    }

    function refreshFolderLabel(): void {
      if (!folderEl) return
      const label = folderLabel()
      folderEl.textContent = label ? `${t("downloads.folder.savingTo")} ${label}` : ""
      folderEl.classList.toggle("hidden", !label)
    }

    function ensureActionDialog(): HTMLDialogElement {
      if (actionDialog) return actionDialog
      const dialog = document.createElement("dialog")
      dialog.id = "tv-downloads-actions-dialog"
      dialog.className =
        "m-auto w-[22rem] max-w-[90vw] rounded-2xl border border-line bg-surface p-0 text-fg backdrop:bg-black/70"
      dialog.innerHTML = `
        <div class="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
          <h2 data-role="title" class="min-w-0 flex-1 truncate text-base font-semibold"></h2>
          <button type="button" data-role="close" class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-3 outline-none tv-focus-inset hover:bg-surface-2 hover:text-fg" aria-label="${t("common.close")}">
            <span class="inline-flex text-base">${ICON_X}</span>
          </button>
        </div>
        <div data-role="actions" class="flex flex-col gap-1 p-2"></div>
      `
      document.body.appendChild(dialog)
      dialog.querySelector('[data-role="close"]')?.addEventListener("click", () => dialog.close())
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close()
      })
      attachDialogSpatialNav(dialog)
      actionDialog = dialog
      return dialog
    }

    async function confirmRemove(item: DownloadItem): Promise<void> {
      const confirmed = await confirmDialog({
        title: t("downloads.delete.title"),
        message: t("downloads.delete.body"),
        confirmLabel: t("downloads.delete.confirm"),
        destructive: true,
      })
      if (confirmed) removeDownload(item.id)
    }

    function openActionSheet(item: DownloadItem): void {
      const dialog = ensureActionDialog()
      const titleEl = dialog.querySelector<HTMLElement>('[data-role="title"]')
      const actionsEl = dialog.querySelector<HTMLElement>('[data-role="actions"]')
      if (titleEl) titleEl.textContent = item.title
      if (actionsEl) {
        actionsEl.replaceChildren()
        const actions: Array<{ label: string; destructive?: boolean; onSelect: () => void }> = []
        if (item.status === "downloading" || item.status === "queued") {
          actions.push({ label: t("downloads.action.pause"), onSelect: () => pauseDownload(item.id) })
        } else if (item.status === "paused" || item.status === "stalled") {
          actions.push({ label: t("downloads.action.resume"), onSelect: () => resumeDownload(item.id) })
        } else if (item.status === "error") {
          actions.push({ label: t("downloads.action.retry"), onSelect: () => resumeDownload(item.id) })
        }
        actions.push({
          label: t("downloads.action.remove"),
          destructive: true,
          onSelect: () => void confirmRemove(item),
        })
        for (const action of actions) {
          const button = document.createElement("button")
          button.type = "button"
          button.className =
            "flex min-h-11 items-center rounded-xl px-4 text-start text-sm outline-none transition-colors " +
            "hover:bg-surface-2 tv-focus-inset" +
            (action.destructive ? " text-bad" : "")
          button.textContent = action.label
          button.addEventListener("click", () => {
            dialog.close()
            action.onSelect()
          })
          actionsEl.appendChild(button)
        }
      }
      if (typeof dialog.showModal === "function") dialog.showModal()
    }

    function onRowActivate(item: DownloadItem): void {
      if (item.status === "done") void playDownloadedItem(item)
      else openActionSheet(item)
    }

    function buildRow(item: DownloadItem): RowRefs {
      const row = document.createElement("div")
      row.dataset.id = item.id
      row.className = "flex min-h-[3.5rem] items-center gap-2 rounded-xl"

      const playButton = document.createElement("button")
      playButton.type = "button"
      playButton.dataset.focusKey = `dl:${item.id}`
      playButton.className =
        "flex min-h-[3.5rem] min-w-0 flex-1 items-center gap-4 rounded-xl px-3 py-2 text-start outline-none " +
        "hover:bg-surface-2 tv-focus-inset"

      const thumbSlot = buildThumb(item.source?.logo)
      const thumbImg = thumbSlot.querySelector<HTMLImageElement>("img")

      const textCol = document.createElement("span")
      textCol.className = "flex min-w-0 flex-1 flex-col gap-1"

      const titleEl = document.createElement("span")
      titleEl.className = "truncate text-sm font-medium text-fg"

      const subtitleEl = document.createElement("span")
      subtitleEl.className = "truncate text-sm text-fg-3"

      const statusEl = document.createElement("span")
      statusEl.className = "truncate text-xs text-fg-3"

      const barShell = document.createElement("span")
      barShell.className = "dl-bar-shell mt-1 block h-[3px] w-full overflow-hidden rounded-full bg-line"
      const barFill = document.createElement("span")
      barFill.className = "dl-bar-fill block h-full rounded-full bg-accent"
      barShell.appendChild(barFill)

      textCol.append(titleEl, subtitleEl, statusEl, barShell)
      playButton.append(thumbSlot, textCol)
      playButton.addEventListener("click", () => onRowActivate(currentItem(item.id) || item))

      row.appendChild(playButton)

      const refs: RowRefs = {
        el: row,
        playButton,
        menuButton: null,
        thumbSlot,
        thumbImg,
        titleEl,
        subtitleEl,
        statusEl,
        barShell,
        barFill,
        logoUrl: item.source?.logo ?? null,
        status: item.status,
      }
      paintRow(refs, item)
      return refs
    }

    function ensureMenuButton(refs: RowRefs, item: DownloadItem): void {
      if (refs.menuButton) return
      const menuButton = document.createElement("button")
      menuButton.type = "button"
      menuButton.dataset.focusKey = `dl-menu:${item.id}`
      menuButton.setAttribute("aria-label", t("tv.downloads.moreAria", { title: item.title }))
      menuButton.className =
        "grid shrink-0 place-items-center rounded-xl p-3 text-fg-3 outline-none transition-colors " +
        "hover:bg-surface-2 hover:text-fg focus-visible:text-fg tv-focus-inset"
      menuButton.innerHTML = `<span class="inline-flex text-base">${ICON_DOTS}</span>`
      menuButton.addEventListener("click", () => openActionSheet(currentItem(item.id) || item))
      refs.el.appendChild(menuButton)
      refs.menuButton = menuButton
    }

    function removeMenuButton(refs: RowRefs): void {
      if (!refs.menuButton) return
      refs.menuButton.remove()
      refs.menuButton = null
    }

    function paintRow(refs: RowRefs, item: DownloadItem): void {
      const logoUrl = item.source?.logo ?? null
      if (logoUrl !== refs.logoUrl) {
        refs.logoUrl = logoUrl
        refs.thumbSlot.replaceChildren()
        if (logoUrl) {
          const img = document.createElement("img")
          img.alt = ""
          img.loading = "lazy"
          img.decoding = "async"
          img.referrerPolicy = "no-referrer"
          img.className = "h-full w-full min-h-0 min-w-0 object-contain"
          mountCachedImage(img, logoUrl, "poster")
          refs.thumbSlot.appendChild(img)
          refs.thumbImg = img
        } else {
          refs.thumbImg = null
        }
      }

      if (refs.titleEl.textContent !== item.title) refs.titleEl.textContent = item.title

      const subtitle = subtitleFor(item)
      refs.subtitleEl.textContent = subtitle
      refs.subtitleEl.classList.toggle("hidden", !subtitle)

      refs.statusEl.textContent = statusLine(item)

      const fraction = progressFraction(item)
      const showBar = item.status === "downloading" || item.status === "paused" || item.status === "stalled"
      refs.barShell.classList.toggle("hidden", !showBar)
      if (showBar) {
        refs.barFill.style.width = `${Math.round((fraction ?? 0) * 100)}%`
        refs.barFill.classList.toggle("bg-bad", item.status === "error")
        refs.barFill.classList.toggle("bg-accent", item.status !== "error")
      }

      if (item.status === "done") ensureMenuButton(refs, item)
      else removeMenuButton(refs)

      refs.status = item.status
    }

    function currentItem(id: string): DownloadItem | undefined {
      return items.find((candidate) => candidate.id === id)
    }

    function renderRows(): void {
      if (!listEl) return
      const ordered = orderedItems(items)
      const seen = new Set<string>()
      let previousNode: ChildNode | null = null

      for (const item of ordered) {
        seen.add(item.id)
        let refs = rowsById.get(item.id)
        if (!refs) {
          refs = buildRow(item)
          rowsById.set(item.id, refs)
        } else {
          paintRow(refs, item)
        }
        const desiredNext: ChildNode | null = previousNode ? previousNode.nextSibling : listEl.firstChild
        if (refs.el !== desiredNext) listEl.insertBefore(refs.el, desiredNext)
        previousNode = refs.el
      }

      for (const [id, refs] of rowsById) {
        if (!seen.has(id)) {
          refs.el.remove()
          rowsById.delete(id)
        }
      }

      if (emptyEl) emptyEl.classList.toggle("hidden", ordered.length > 0)
      if (countEl) countEl.textContent = t("tv.downloads.count", { count: ordered.length })
    }

    function onDownloadsListEvent(event: Event): void {
      const detail = (event as CustomEvent).detail
      items = Array.isArray(detail) ? detail : listDownloads()
      scheduleRefresh()
    }

    function onDownloadProgressEvent(): void {
      items = listDownloads()
      scheduleRefresh()
    }

    function onThroughputEvent(): void {
      scheduleRefresh()
    }

    function applyLocale(): void {
      refreshFolderLabel()
      if (countEl) countEl.textContent = t("tv.downloads.count", { count: items.length })
      for (const [id, refs] of rowsById) {
        const item = currentItem(id)
        if (item) paintRow(refs, item)
      }
    }

    function renderShell(): void {
      root.innerHTML = `
        <div class="flex h-full flex-col gap-6">
          <header class="flex shrink-0 flex-col gap-1">
            <div class="flex items-baseline gap-3">
              <h1 tabindex="0" data-tv-autofocus class="rounded-lg text-xl font-semibold text-fg outline-none tv-focus-inset" data-role="heading"></h1>
              <span data-role="count" class="text-sm text-fg-3"></span>
            </div>
            <p data-role="folder" class="hidden text-sm text-fg-3"></p>
          </header>
          <div data-role="scroller" class="min-h-0 flex-1 overflow-hidden">
            <div data-role="list" class="flex flex-col gap-1"></div>
            <p data-role="empty" class="hidden flex-col items-center gap-1 px-4 py-16 text-center"></p>
          </div>
        </div>
      `
      root.querySelector<HTMLElement>('[data-role="heading"]')!.textContent = t("nav.downloads")
      scrollerEl = root.querySelector<HTMLElement>('[data-role="scroller"]')
      listEl = root.querySelector<HTMLElement>('[data-role="list"]')
      countEl = root.querySelector<HTMLElement>('[data-role="count"]')
      folderEl = root.querySelector<HTMLElement>('[data-role="folder"]')
      emptyEl = root.querySelector<HTMLElement>('[data-role="empty"]')
      if (emptyEl) {
        emptyEl.classList.add("flex")
        const heading = document.createElement("span")
        heading.className = "text-base font-medium text-fg"
        heading.textContent = t("downloads.empty.heading")
        const helper = document.createElement("span")
        helper.className = "max-w-sm text-sm text-fg-3"
        helper.textContent = t("downloads.empty.helper")
        emptyEl.append(heading, helper)
      }

      refreshFolderLabel()

      for (let i = 0; i < SKELETON_ROW_COUNT; i++) listEl!.appendChild(buildSkeletonRow())

      listEl!.id = "tv-downloads-list"
      unsubs.push(
        registerFocusSection("tv-downloads", listEl!, {
          enterTo: "last-focused",
        })
      )
      if (scrollerEl) unsubs.push(keepFocusedInView(scrollerEl, "y", () => remPx(LIST_KEEP_IN_VIEW_REM)))

      document.addEventListener(DOWNLOADS_LIST_EVENT, onDownloadsListEvent)
      document.addEventListener(DOWNLOAD_PROGRESS_EVENT, onDownloadProgressEvent)
      document.addEventListener(THROUGHPUT_EVENT, onThroughputEvent)
      document.addEventListener(LOCALE_EVENT, applyLocale)
    }

    function boot(): void {
      renderShell()
      items = listDownloads()
      if (listEl) listEl.replaceChildren()
      renderRows()

      const alreadyFocused = root.contains(document.activeElement) && document.activeElement !== root
      if (!alreadyFocused) {
        const firstRow = listEl?.querySelector<HTMLElement>("[data-focus-key]")
        if (firstRow) firstRow.focus()
        else root.querySelector<HTMLElement>("[data-tv-autofocus]")?.focus()
      }
    }

    boot()

    return () => {
      destroyed = true
      if (flushTimer != null) clearTimeout(flushTimer)
      document.removeEventListener(DOWNLOADS_LIST_EVENT, onDownloadsListEvent)
      document.removeEventListener(DOWNLOAD_PROGRESS_EVENT, onDownloadProgressEvent)
      document.removeEventListener(THROUGHPUT_EVENT, onThroughputEvent)
      document.removeEventListener(LOCALE_EVENT, applyLocale)
      for (const unsub of unsubs) unsub()
      try {
        actionDialog?.close()
      } catch {}
      actionDialog?.remove()
      rowsById.clear()
      root.replaceChildren()
    }
  },
}

export default view
