// Playlist editor bundle for /playlist-editor; every mutation goes through `applyDoc()`.

import { invalidateEntry } from "@/scripts/lib/cache.js"
import {
  loadCustomDoc,
  saveCustomDoc,
  addChannel,
  addHeader,
  isHeaderChannel,
  removeChannels,
  moveChannel,
  moveChannels,
  moveChannelWithinGroup,
  moveChannelsWithinGroup,
  setOverrides,
  clearNameOverrides,
  sortChannels,
  setCatchup,
  setChannelGroup,
  renameGroup,
  reorderGroups,
  removeGroup,
  resolveCustomChannels,
  customSourceKey,
  presentSourceKeys,
  presentSourceKeysByGroup,
  copySourceOf,
  UNCATEGORIZED,
  type CustomPlaylistDoc,
  type CustomChannel,
  type CustomSource,
  type ResolvedCustomChannel,
} from "@/scripts/lib/custom-playlist.ts"
import { getEntries, entryToCreds, updateEntry } from "@/scripts/lib/creds.js"
import { ensureLive, buildCustomSourcePools } from "@/scripts/lib/catalog.js"
import { ensureLoaded as ensurePrefsLoaded, getFavorites, getFavoritesOrdered } from "@/scripts/lib/preferences.js"
import { serializeM3U } from "@/scripts/lib/m3u-serializer.ts"
import { buildM3UEntriesForEntry, saveM3UText, sanitizeFilename } from "@/scripts/lib/export-m3u.ts"
import { probeStreamHead } from "@/scripts/lib/stream-diagnostic.js"
import { matchesNormQuery, normalize, parseSearchQuery } from "@/scripts/lib/text.ts"
import { debounce } from "@/scripts/lib/debounce.ts"
import { t, tCount } from "@/scripts/lib/i18n.ts"
import { toastSuccess, toastError, toastWarn } from "@/scripts/lib/toast.ts"
import { openCustomChannelEditDialog } from "@/scripts/lib/custom-channel-edit-dialog.ts"
import { confirmDialog } from "@/scripts/lib/confirm-dialog.ts"
import { attachDialogSpatialNav, attachPopoverSpatialNav } from "@/scripts/lib/dialog-spatial-nav.ts"
import { ICON_GRIP_VERTICAL, ICON_ARROW_UP, ICON_ARROW_DOWN, ICON_DOTS_VERTICAL, ICON_CHEVRON_DOWN, ICON_CHECK } from "@/scripts/lib/icons.ts"
import { log } from "@/scripts/lib/log.ts"
import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { getDensityFactor } from "@/scripts/lib/app-settings.js"
import { escapeHtml } from "@/scripts/lib/format.ts"

const ROW_H = Math.max(44, Math.round(56 * getDensityFactor()))
const SOURCE_OVERSCAN = 6

let entryId = ""
let customEntry: any = null
let doc: CustomPlaylistDoc = { version: 1, nextId: 1, groups: [], channels: [] }

let allSourceChannels: any[] = []
let filteredSourceChannels: any[] = []
let selectedSourceEntryId = ""
let selectedSourceEntryType = ""
let sourceDocChannelsById = new Map<number, CustomChannel>()
const selectedIds = new Set<number>()
let lastClickedIndex = -1

const selectedChannelKeys = new Set<string>()
let lastSelectedChannelKey: string | null = null

let orderedChannels: CustomChannel[] = []
let resolvedChannels: ResolvedCustomChannel[] = []
let sourceTitleById = new Map<string, string>()
let presentSourceKeySet = new Set<string>()
let presentSourceKeysByGroupMap = new Map<string, Set<string>>()

const MAX_UNDO_DEPTH = 20
const undoStack: CustomPlaylistDoc[] = []
const redoStack: CustomPlaylistDoc[] = []

type LinkCheckStatus = "pending" | "ok" | "fail" | "unchecked"
const linkCheckStatus = new Map<string, LinkCheckStatus>()
let checkLinksRunning = false
let checkLinksAbort: AbortController | null = null
let checkLinksProgress = { done: 0, total: 0 }

type SaveStatus = "idle" | "saving" | "saved" | "failed"
let saveShowSavingTimer: ReturnType<typeof setTimeout> | null = null
let saveClearTimer: ReturnType<typeof setTimeout> | null = null

// Settled (unedited-since-commit) inputs defer Ctrl+Z to the doc-level undo.
const inputCommittedValues = new WeakMap<HTMLInputElement, string>()
function markInputCommitted(input: HTMLInputElement): void {
  inputCommittedValues.set(input, input.value)
}
function isSettledTrackedInput(input: HTMLInputElement): boolean {
  return inputCommittedValues.has(input) && inputCommittedValues.get(input) === input.value
}

const PANE_STORAGE_KEY = "xt_editor_pane"
let activePane: "source" | "playlist" = "playlist"

const SOURCE_SORT_STORAGE_KEY = "xt_editor_source_sort"

const COLLAPSED_GROUPS_KEY_PREFIX = "xt_editor_collapsed_groups_"
let collapsedGroups = new Set<string>()

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const byId = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null

const titleInput = byId<HTMLInputElement>("editor-title-input")
const channelCountEl = byId<HTMLElement>("editor-channel-count")
const saveStatusEl = byId<HTMLElement>("editor-save-status")
const saveRetryBtn = byId<HTMLButtonElement>("editor-save-retry")
const sourceSelect = byId<HTMLSelectElement>("editor-source-select")
const sourceSearchInput = byId<HTMLInputElement>("editor-source-search")
const sourceCategorySelect = byId<HTMLSelectElement>("editor-source-category")
const sourceSortSelect = byId<HTMLSelectElement>("editor-source-sort")
const sourceSelectAllBtn = byId<HTMLButtonElement>("editor-source-select-all-btn")
const sourceDeselectAllBtn = byId<HTMLButtonElement>("editor-source-deselect-all-btn")
const sourceListEl = byId<HTMLElement>("editor-source-list")
const sourceSpacer = byId<HTMLElement>("editor-source-spacer")
const sourceViewport = byId<HTMLElement>("editor-source-viewport")
const sourceEmptyEl = byId<HTMLElement>("editor-source-empty")
const sourceSelectedCountEl = byId<HTMLElement>("editor-source-selected-count")
const sourceTargetGroupInput = byId<HTMLInputElement>("editor-source-target-group")
const addSelectedBtn = byId<HTMLButtonElement>("editor-add-selected-btn")

const panesEl = byId<HTMLElement>("editor-panes")
const paneTabSourceBtn = byId<HTMLButtonElement>("editor-pane-tab-source")
const paneTabPlaylistBtn = byId<HTMLButtonElement>("editor-pane-tab-playlist")

const groupsContainer = byId<HTMLElement>("editor-groups")
const bulkActionsBar = byId<HTMLElement>("editor-bulk-actions-bar")
const bulkSelectedCountEl = byId<HTMLElement>("editor-selected-count")
const bulkMoveUpBtn = byId<HTMLButtonElement>("editor-bulk-move-up-btn")
const bulkMoveDownBtn = byId<HTMLButtonElement>("editor-bulk-move-down-btn")
const bulkMoveToGroupBtn = byId<HTMLButtonElement>("editor-bulk-move-to-group-btn")
const bulkMoreBtn = byId<HTMLButtonElement>("editor-bulk-more-btn")
const bulkRemoveBtn = byId<HTMLButtonElement>("editor-bulk-remove-btn")
const bulkClearBtn = byId<HTMLButtonElement>("editor-bulk-clear-btn")
const emptyStateEl = byId<HTMLElement>("editor-empty-state")
const emptyAddUrlBtn = byId<HTMLButtonElement>("editor-empty-add-url-btn")
const emptySourceBtn = byId<HTMLButtonElement>("editor-empty-source-btn")

const undoBtn = byId<HTMLButtonElement>("editor-undo-btn")
const redoBtn = byId<HTMLButtonElement>("editor-redo-btn")

const newGroupBtn = byId<HTMLButtonElement>("editor-new-group-btn")
const newGroupDialog = byId<HTMLDialogElement>("editor-new-group-dialog")
const newGroupNameInput = byId<HTMLInputElement>("editor-new-group-name")

const bulkRenameDialog = byId<HTMLDialogElement>("editor-bulk-rename-dialog")
const bulkRenameFindInput = byId<HTMLInputElement>("editor-bulk-rename-find")
const bulkRenameReplaceInput = byId<HTMLInputElement>("editor-bulk-rename-replace")
const bulkRenameMatchCaseInput = byId<HTMLInputElement>("editor-bulk-rename-matchcase")
const bulkRenamePreviewEl = byId<HTMLElement>("editor-bulk-rename-preview")
const bulkRenamePreviewSampleEl = byId<HTMLElement>("editor-bulk-rename-preview-sample")

const checkLinksChipEl = byId<HTMLElement>("editor-check-links-chip")
const checkLinksChipLabelEl = byId<HTMLElement>("editor-check-links-chip-label")
const checkLinksChipCancelBtn = byId<HTMLButtonElement>("editor-check-links-chip-cancel")

const toolbarMoreBtn = byId<HTMLButtonElement>("editor-toolbar-more-btn")

const groupsDatalist = byId<HTMLDataListElement>("editor-groups-datalist")

const addUrlBtn = byId<HTMLButtonElement>("editor-add-url-btn")
const addUrlDialog = byId<HTMLDialogElement>("editor-add-url-dialog")
const urlUrlInput = byId<HTMLInputElement>("editor-url-url")
const urlErrorEl = byId<HTMLElement>("editor-url-error")
const urlNameInput = byId<HTMLInputElement>("editor-url-name")
const urlGroupInput = byId<HTMLInputElement>("editor-url-group")
const urlLogoInput = byId<HTMLInputElement>("editor-url-logo")
const urlUaInput = byId<HTMLInputElement>("editor-url-ua")
const urlRefererInput = byId<HTMLInputElement>("editor-url-referer")
const urlManifestSelect = byId<HTMLSelectElement>("editor-url-manifest")
const urlLicenseInput = byId<HTMLInputElement>("editor-url-license")

let exportRunning = false

// ---------------------------------------------------------------------------
// Shared popover menu (mirrors stream.ts's openChannelMenu styling/behavior)
// ---------------------------------------------------------------------------
interface MenuItemDef {
  key: string
  label: string
  onClick: () => void
  destructive?: boolean
  disabled?: boolean
  separatorBefore?: boolean
}

const MENU_ID = "editor-popover-menu"
const MENU_ITEM_CLASS =
  "w-full text-left px-3 py-2 min-h-11 flex items-center rounded-lg text-sm " +
  "hover:bg-surface-2 focus:bg-surface-2 outline-none"
let menuEl: HTMLElement | null = null
let menuReturnFocus: HTMLElement | null = null
let menuAnchorRowKey: string | null = null
let menuAnchorGroupName: string | null = null
const menuSpatialNav = attachPopoverSpatialNav({
  id: `${MENU_ID}-section`,
  selector: `#${MENU_ID} [role="menuitem"]`,
})

function closeMenu(): void {
  if (!menuEl) return
  menuSpatialNav.close()
  menuEl.remove()
  menuEl = null
  menuAnchorRowKey = null
  menuAnchorGroupName = null
  document.removeEventListener("pointerdown", onMenuOutside, true)
  document.removeEventListener("keydown", onMenuKey, true)
  window.removeEventListener("blur", closeMenu)
  window.removeEventListener("resize", closeMenu)
  const returnTo = menuReturnFocus
  menuReturnFocus = null
  returnTo?.focus()
}
function onMenuOutside(event: PointerEvent): void {
  if (!menuEl) return
  if (menuEl.contains(event.target as Node)) return
  closeMenu()
}
function onMenuKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault()
    closeMenu()
  }
}

function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect()
  const menuRect = menu.getBoundingClientRect()
  let top = rect.bottom + 4
  let left = rect.right - menuRect.width
  if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 4)
  if (left < 8) left = 8
  if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8
  menu.style.top = `${top}px`
  menu.style.left = `${left}px`
}

function openMenu(anchor: HTMLButtonElement, items: MenuItemDef[], ariaLabel: string): void {
  closeMenu()
  const menu = document.createElement("div")
  menu.id = MENU_ID
  menu.className =
    "fixed z-50 min-w-[12rem] rounded-xl border border-line bg-surface text-fg shadow-2xl " +
    "p-1 flex flex-col gap-0.5"
  menu.setAttribute("role", "menu")
  menu.setAttribute("aria-label", ariaLabel)
  for (const item of items) {
    if (item.separatorBefore) {
      const separator = document.createElement("div")
      separator.setAttribute("role", "separator")
      separator.className = "my-1 h-px bg-line"
      menu.appendChild(separator)
    }
    const itemBtn = document.createElement("button")
    itemBtn.type = "button"
    itemBtn.setAttribute("role", "menuitem")
    itemBtn.className = MENU_ITEM_CLASS + (item.destructive ? " hover:text-bad focus:text-bad" : "")
    itemBtn.textContent = item.label
    itemBtn.disabled = !!item.disabled
    itemBtn.dataset.action = item.key
    itemBtn.addEventListener("click", () => {
      closeMenu()
      item.onClick()
    })
    menu.appendChild(itemBtn)
  }
  document.body.appendChild(menu)
  menuEl = menu
  menuReturnFocus = anchor
  positionMenu(menu, anchor)
  menuSpatialNav.open()
  document.addEventListener("pointerdown", onMenuOutside, true)
  document.addEventListener("keydown", onMenuKey, true)
  window.addEventListener("blur", closeMenu)
  window.addEventListener("resize", closeMenu)
  menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus()
}

// ---------------------------------------------------------------------------
// Ordering / pool helpers (mirrors the store's own bucketing)
// ---------------------------------------------------------------------------
function orderedChannelsByGroup(source: CustomPlaylistDoc): CustomChannel[] {
  const buckets = new Map<string, CustomChannel[]>(source.groups.map((group) => [group, []]))
  const stray: CustomChannel[] = []
  for (const channel of source.channels) {
    const bucket = buckets.get(channel.group)
    if (bucket) bucket.push(channel)
    else stray.push(channel)
  }
  return [...source.groups.flatMap((group) => buckets.get(group) || []), ...stray]
}

async function refreshResolvedChannels(): Promise<void> {
  const snapshot = doc
  const pools = await buildCustomSourcePools(snapshot)
  if (snapshot !== doc) return // superseded by a newer mutation
  orderedChannels = orderedChannelsByGroup(snapshot)
  resolvedChannels = resolveCustomChannels(snapshot, pools)
}

function findResolved(channel: CustomChannel): ResolvedCustomChannel | undefined {
  return resolvedChannels.find((resolved) => resolved.id === channel.id)
}

function anyUnresolvedChannels(): boolean {
  return resolvedChannels.some((resolved) => resolved.unresolved)
}

function channelDisplayName(channel: CustomChannel): string {
  return channel.overrides.name ?? findResolved(channel)?.name ?? ""
}

/** Drops keys that aren't a non-header row in the current doc. */
function nonHeaderKeysIn(keys: string[]): string[] {
  return keys.filter((key) => {
    const channel = doc.channels.find((item) => item.key === key)
    return !!channel && !isHeaderChannel(channel)
  })
}

/** Non-header keys among the given ones whose name currently carries an override. */
function nameOverrideKeysIn(keys: string[]): string[] {
  return nonHeaderKeysIn(keys).filter((key) => doc.channels.find((item) => item.key === key)?.overrides.name != null)
}

function sortChannelsWithToast(keys: string[], direction: "asc" | "desc"): void {
  const nextDoc = sortChannels(doc, keys, direction, channelDisplayName)
  if (nextDoc === doc) return
  applyDoc(nextDoc)
  toastSuccess(t("editor.toastSorted"), {
    action: { label: t("common.undo"), onClick: () => undo() },
  })
}

function resetNamesWithToast(keys: string[]): void {
  const nextDoc = clearNameOverrides(doc, keys)
  if (nextDoc === doc) return
  applyDoc(nextDoc)
  toastSuccess(t("editor.toastNameReset"), {
    action: { label: t("common.undo"), onClick: () => undo() },
  })
}

function sourceTitleForChannel(channel: CustomChannel): string | null {
  const source = channel.sources[0]
  if (!source || source.kind === "direct") return null
  return sourceTitleById.get(source.entryId) || null
}

function reorderGroupPosition(source: CustomPlaylistDoc, groupName: string, direction: "up" | "down"): CustomPlaylistDoc {
  const idx = source.groups.indexOf(groupName)
  if (idx === -1) return source
  const swapIdx = direction === "up" ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= source.groups.length) return source
  const nextGroups = [...source.groups]
  const tmp = nextGroups[idx]
  nextGroups[idx] = nextGroups[swapIdx]
  nextGroups[swapIdx] = tmp
  return reorderGroups(source, nextGroups)
}

function withNewGroup(source: CustomPlaylistDoc, name: string): CustomPlaylistDoc {
  if (!name || source.groups.includes(name)) return source
  return { ...source, groups: [...source.groups, name] }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function setSaveStatus(status: SaveStatus): void {
  if (saveShowSavingTimer) {
    clearTimeout(saveShowSavingTimer)
    saveShowSavingTimer = null
  }
  if (saveClearTimer) {
    clearTimeout(saveClearTimer)
    saveClearTimer = null
  }
  if (status === "saving") {
    // Debounced so a save that resolves in under 300ms never flashes "Saving…".
    saveShowSavingTimer = setTimeout(() => {
      if (!saveStatusEl) return
      saveStatusEl.textContent = t("editor.savingStatus")
      saveStatusEl.classList.remove("text-warn")
      saveStatusEl.classList.add("text-fg-3")
      saveRetryBtn?.classList.add("hidden")
    }, 300)
    return
  }
  if (!saveStatusEl) return
  if (status === "saved") {
    saveStatusEl.textContent = t("editor.savedStatus")
    saveStatusEl.classList.remove("text-warn")
    saveStatusEl.classList.add("text-fg-3")
    saveRetryBtn?.classList.add("hidden")
    saveClearTimer = setTimeout(() => {
      if (saveStatusEl) saveStatusEl.textContent = ""
    }, 2000)
  } else if (status === "failed") {
    saveStatusEl.textContent = t("editor.saveFailedStatus")
    saveStatusEl.classList.remove("text-fg-3")
    saveStatusEl.classList.add("text-warn")
    saveRetryBtn?.classList.remove("hidden")
  } else {
    saveStatusEl.textContent = ""
    saveRetryBtn?.classList.add("hidden")
  }
}

async function flushSave(): Promise<void> {
  setSaveStatus("saving")
  try {
    const saved = await saveCustomDoc(entryId, doc)
    if (!saved) {
      setSaveStatus("failed")
      toastError(t("editor.toastSaveFailed"))
      return
    }
    setSaveStatus("saved")
    invalidateEntry(entryId)
    document.dispatchEvent(new CustomEvent("xt:entries-updated"))
  } catch (err) {
    log.warn("[xt:editor] save failed:", err)
    setSaveStatus("failed")
    toastError(t("editor.toastSaveFailed"))
  }
}

const scheduleSave = debounce(() => {
  void flushSave()
}, 300)

const scheduleResolvedRefresh = debounce(() => {
  void refreshResolvedChannels().then(() => renderGroups())
}, 250)

function commitDoc(nextDoc: CustomPlaylistDoc): void {
  doc = nextDoc
  orderedChannels = orderedChannelsByGroup(nextDoc)
  presentSourceKeySet = presentSourceKeys(nextDoc)
  presentSourceKeysByGroupMap = presentSourceKeysByGroup(nextDoc)
  pruneSelection()
  renderChannelCount()
  renderGroups()
  updateBulkActionsBar()
  updateUndoButton()
  scheduleSave()
  scheduleResolvedRefresh()
  scheduleSourceRender()
}

// ---------------------------------------------------------------------------
// Right-pane multi-select
// ---------------------------------------------------------------------------
function pruneSelection(): void {
  if (!selectedChannelKeys.size) return
  const liveKeys = new Set(doc.channels.map((channel) => channel.key))
  for (const key of selectedChannelKeys) {
    if (!liveKeys.has(key)) selectedChannelKeys.delete(key)
  }
  if (lastSelectedChannelKey && !liveKeys.has(lastSelectedChannelKey)) lastSelectedChannelKey = null
}

function updateGroupSelectCheckbox(checkbox: HTMLInputElement, groupChannelKeys: string[]): void {
  if (!groupChannelKeys.length) {
    checkbox.checked = false
    checkbox.indeterminate = false
    return
  }
  const selectedCount = groupChannelKeys.filter((key) => selectedChannelKeys.has(key)).length
  checkbox.checked = selectedCount === groupChannelKeys.length
  checkbox.indeterminate = selectedCount > 0 && selectedCount < groupChannelKeys.length
}

function updateBulkActionsBar(): void {
  const count = selectedChannelKeys.size
  bulkActionsBar?.classList.toggle("hidden", count === 0)
  bulkActionsBar?.classList.toggle("flex", count > 0)
  if (bulkSelectedCountEl) bulkSelectedCountEl.textContent = count ? t("editor.selectedCount", { count }) : ""
}

// Lightweight DOM sync for a pure selection change: never rebuilds rows, so it can't lose focus.
function syncSelectionUI(): void {
  for (const cached of channelRowCache.values()) {
    const channelKey = cached.refs.el.dataset.key
    if (!channelKey) continue
    const selected = selectedChannelKeys.has(channelKey)
    cached.refs.checkbox.checked = selected
    cached.refs.el.dataset.selected = selected ? "true" : "false"
  }
  if (groupsContainer) {
    const groupKeys = new Map<string, string[]>()
    for (const channel of orderedChannels) {
      const bucket = groupKeys.get(channel.group)
      if (bucket) bucket.push(channel.key)
      else groupKeys.set(channel.group, [channel.key])
    }
    groupsContainer.querySelectorAll<HTMLElement>(".editor-group-section[data-group]").forEach((section) => {
      const groupName = section.dataset.group
      const checkbox = section.querySelector<HTMLInputElement>('[data-action="select-group"]')
      if (groupName && checkbox) updateGroupSelectCheckbox(checkbox, groupKeys.get(groupName) || [])
    })
  }
  updateBulkActionsBar()
}

function toggleChannelSelection(key: string): void {
  if (selectedChannelKeys.has(key)) selectedChannelKeys.delete(key)
  else selectedChannelKeys.add(key)
  syncSelectionUI()
}

function toggleGroupSelection(groupChannelKeys: string[]): void {
  const allSelected = groupChannelKeys.length > 0 && groupChannelKeys.every((key) => selectedChannelKeys.has(key))
  for (const key of groupChannelKeys) {
    if (allSelected) selectedChannelKeys.delete(key)
    else selectedChannelKeys.add(key)
  }
  syncSelectionUI()
}

function selectGroupChannels(groupChannelKeys: string[]): void {
  for (const key of groupChannelKeys) selectedChannelKeys.add(key)
  syncSelectionUI()
}

function deselectGroupChannels(groupChannelKeys: string[]): void {
  for (const key of groupChannelKeys) selectedChannelKeys.delete(key)
  syncSelectionUI()
}

function clearSelection(): void {
  if (!selectedChannelKeys.size) return
  selectedChannelKeys.clear()
  lastSelectedChannelKey = null
  syncSelectionUI()
}

// Shift-range only spans rows within the same group, computed over that group's rendered order.
function handleChannelRowSelectClick(channel: CustomChannel, event: MouseEvent): void {
  if (event.shiftKey && lastSelectedChannelKey) {
    const lastChannel = doc.channels.find((item) => item.key === lastSelectedChannelKey)
    if (lastChannel && lastChannel.group === channel.group) {
      const groupOrder = orderedChannels.filter((item) => item.group === channel.group)
      const fromIndex = groupOrder.findIndex((item) => item.key === lastSelectedChannelKey)
      const toIndex = groupOrder.findIndex((item) => item.key === channel.key)
      if (fromIndex !== -1 && toIndex !== -1) {
        const [start, end] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex]
        for (let i = start; i <= end; i++) selectedChannelKeys.add(groupOrder[i].key)
        lastSelectedChannelKey = channel.key
        syncSelectionUI()
        return
      }
    }
  }
  toggleChannelSelection(channel.key)
  lastSelectedChannelKey = channel.key
}

async function removeSelectedChannelsWithUndo(): Promise<void> {
  const keys = [...selectedChannelKeys]
  if (!keys.length) return
  const confirmed = await confirmDialog({
    title: t("editor.removeSelectedTitle"),
    message: tCount("editor.removeSelectedConfirm", keys.length),
    confirmLabel: t("editor.removeSelected"),
    destructive: true,
  })
  if (!confirmed) return
  applyDoc(removeChannels(doc, keys))
  toastSuccess(tCount("editor.toastChannelsRemoved", keys.length), {
    action: { label: t("common.undo"), onClick: () => undo() },
  })
}

function openBulkMoveToGroupMenu(trigger: HTMLButtonElement): void {
  const keys = [...selectedChannelKeys]
  if (!keys.length) return
  const items: MenuItemDef[] = doc.groups.map((group, index) => ({
    key: `group:${index}`,
    label: group,
    onClick: () => applyDoc(setChannelGroup(doc, keys, group)),
  }))
  openMenu(trigger, items, t("editor.moveToGroupLabel"))
}

function openBulkMoreMenu(trigger: HTMLButtonElement): void {
  const keys = [...selectedChannelKeys]
  if (!keys.length) return
  const sortableKeys = nonHeaderKeysIn(keys)
  const resettableKeys = nameOverrideKeysIn(keys)
  const items: MenuItemDef[] = [
    {
      key: "sort-az",
      label: t("editor.sortAz"),
      disabled: sortableKeys.length < 2,
      onClick: () => sortChannelsWithToast(sortableKeys, "asc"),
    },
    {
      key: "sort-za",
      label: t("editor.sortZa"),
      disabled: sortableKeys.length < 2,
      onClick: () => sortChannelsWithToast(sortableKeys, "desc"),
    },
    {
      key: "reset-name",
      label: t("editor.resetName"),
      disabled: !resettableKeys.length,
      separatorBefore: true,
      onClick: () => resetNamesWithToast(resettableKeys),
    },
  ]
  openMenu(trigger, items, t("editor.moreActions"))
}

function wireSelectionEscape(): void {
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return
      if (!selectedChannelKeys.size || menuEl || touchDragState || document.querySelector("dialog[open]")) return
      event.preventDefault()
      clearSelection()
    },
    true
  )
}

// Single chokepoint for every doc mutation: undo snapshot, debounced persist, re-render.
function applyDoc(nextDoc: CustomPlaylistDoc): void {
  if (nextDoc === doc) return
  undoStack.push(doc)
  if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift()
  redoStack.length = 0
  commitDoc(nextDoc)
}

function undo(): void {
  const previousDoc = undoStack.pop()
  if (!previousDoc) return
  redoStack.push(doc)
  commitDoc(previousDoc)
}

function redo(): void {
  const nextDoc = redoStack.pop()
  if (!nextDoc) return
  undoStack.push(doc)
  commitDoc(nextDoc)
}

function updateUndoButton(): void {
  if (undoBtn) undoBtn.disabled = undoStack.length === 0
  if (redoBtn) redoBtn.disabled = redoStack.length === 0
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function renderChannelCount(): void {
  const count = doc.channels.filter((channel) => !isHeaderChannel(channel)).length
  if (channelCountEl) channelCountEl.textContent = tCount("editor.channelCount", count)
}

function saveTitleNow(): void {
  if (!titleInput || !customEntry) return
  const value = titleInput.value.trim()
  if (!value || value === customEntry.title) return
  customEntry.title = value
  markInputCommitted(titleInput)
  updateEntry(entryId, { title: value }).catch((err) => {
    log.warn("[xt:editor] title save failed:", err)
    toastError(t("editor.toastSaveFailed"))
  })
}

const scheduleTitleSave = debounce(saveTitleNow, 400)

// ---------------------------------------------------------------------------
// Source browser (left pane)
// ---------------------------------------------------------------------------
function loadSourceSortMode(): void {
  if (!sourceSortSelect) return
  try {
    const stored = sessionStorage.getItem(SOURCE_SORT_STORAGE_KEY)
    if (stored === "default" || stored === "az" || stored === "za") sourceSortSelect.value = stored
  } catch {
    // sessionStorage unavailable (private browsing etc); keep the default.
  }
}

function saveSourceSortMode(mode: string): void {
  try {
    sessionStorage.setItem(SOURCE_SORT_STORAGE_KEY, mode)
  } catch {
    // Best-effort only.
  }
}

function populateSourceSelect(entries: any[]): void {
  if (!sourceSelect) return
  const candidates = entries.filter((entry) => entry._id !== entryId)
  sourceSelect.replaceChildren()
  if (!candidates.length) {
    const opt = document.createElement("option")
    opt.value = ""
    opt.textContent = t("editor.noSources")
    sourceSelect.appendChild(opt)
    sourceSelect.disabled = true
    mountSourceEmpty(t("editor.noSources"))
    return
  }
  const placeholder = document.createElement("option")
  placeholder.value = ""
  placeholder.textContent = t("editor.sourceSelectPlaceholder")
  sourceSelect.appendChild(placeholder)
  for (const entry of candidates) {
    const opt = document.createElement("option")
    opt.value = entry._id
    opt.textContent = entry.title || entry._id
    sourceSelect.appendChild(opt)
  }
  mountSourceEmpty(t("editor.selectSourcePrompt"))
}

function mountSourceEmpty(message: string): void {
  if (sourceSpacer) sourceSpacer.style.height = "0px"
  if (sourceViewport) sourceViewport.replaceChildren()
  if (sourceEmptyEl) {
    sourceEmptyEl.textContent = message
    sourceEmptyEl.classList.remove("hidden")
  }
}

function hideSourceEmpty(): void {
  sourceEmptyEl?.classList.add("hidden")
}

const CAT_FAVORITES = "__favorites__"

function populateCategoryFilter(): void {
  if (!sourceCategorySelect) return
  const previousValue = sourceCategorySelect.value
  const categories = new Set<string>()
  for (const channel of allSourceChannels) {
    if (channel.category) categories.add(channel.category)
  }
  const sorted = [...categories].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))
  sourceCategorySelect.replaceChildren()
  const allOpt = document.createElement("option")
  allOpt.value = ""
  allOpt.textContent = t("list.allCategories")
  sourceCategorySelect.appendChild(allOpt)
  const favoriteCount = getFavorites(selectedSourceEntryId, "live").size
  if (favoriteCount > 0) {
    const favOpt = document.createElement("option")
    favOpt.value = CAT_FAVORITES
    favOpt.textContent = `${t("list.specialFavorites")} (${favoriteCount})`
    sourceCategorySelect.appendChild(favOpt)
  }
  for (const category of sorted) {
    const opt = document.createElement("option")
    opt.value = category
    opt.textContent = category
    sourceCategorySelect.appendChild(opt)
  }
  const stillExists = [...sourceCategorySelect.options].some((opt) => opt.value === previousValue)
  sourceCategorySelect.value = stillExists ? previousValue : ""
}

function updateSelectedCount(): void {
  if (sourceSelectedCountEl) {
    sourceSelectedCountEl.textContent = selectedIds.size
      ? t("editor.selectedCount", { count: selectedIds.size })
      : ""
  }
  if (addSelectedBtn) addSelectedBtn.disabled = selectedIds.size === 0
}

async function onSourceChange(): Promise<void> {
  const requestedSourceEntryId = sourceSelect?.value || ""
  selectedSourceEntryId = requestedSourceEntryId
  selectedIds.clear()
  lastClickedIndex = -1
  updateSelectedCount()
  allSourceChannels = []
  filteredSourceChannels = []
  sourceDocChannelsById = new Map()
  if (!requestedSourceEntryId) {
    mountSourceEmpty(t("editor.selectSourcePrompt"))
    if (sourceCategorySelect) sourceCategorySelect.replaceChildren()
    return
  }
  mountSourceEmpty(t("common.loading"))
  let entries: any[]
  try {
    entries = await getEntries()
  } catch (err) {
    log.warn("[xt:editor] getEntries failed:", err)
    if (selectedSourceEntryId !== requestedSourceEntryId) return
    toastError(t("editor.toastLoadFailed"))
    mountSourceEmpty(t("editor.sourceEmpty"))
    return
  }
  if (selectedSourceEntryId !== requestedSourceEntryId) return
  const sourceEntry = entries.find((entry: any) => entry._id === requestedSourceEntryId)
  if (!sourceEntry) {
    mountSourceEmpty(t("editor.sourceEmpty"))
    return
  }
  selectedSourceEntryType = sourceEntry.type
  if (sourceEntry.type === "custom") {
    try {
      const sourceDoc = await loadCustomDoc(sourceEntry._id)
      if (selectedSourceEntryId !== requestedSourceEntryId) return
      sourceDocChannelsById = new Map(sourceDoc.channels.map((channel) => [channel.id, channel]))
    } catch (err) {
      log.warn("[xt:editor] source doc load failed:", err)
      if (selectedSourceEntryId !== requestedSourceEntryId) return
      sourceDocChannelsById = new Map()
    }
  }
  try {
    const channels = await ensureLive(entryToCreds(sourceEntry), sourceEntry._id, { includeHidden: true })
    if (selectedSourceEntryId !== requestedSourceEntryId) return
    allSourceChannels = channels || []
  } catch (err) {
    log.warn("[xt:editor] source load failed:", err)
    if (selectedSourceEntryId !== requestedSourceEntryId) return
    allSourceChannels = []
  }
  if (sourceEntry.type === "custom") {
    allSourceChannels = allSourceChannels.filter((channel) => !channel.isHeader)
  }
  await ensurePrefsLoaded()
  if (selectedSourceEntryId !== requestedSourceEntryId) return
  populateCategoryFilter()
  applySourceFilter()
}

function applySourceFilter(): void {
  lastClickedIndex = -1
  const tokens = parseSearchQuery(sourceSearchInput?.value || "")
  const category = sourceCategorySelect?.value || ""
  const isFavoritesCategory = category === CAT_FAVORITES
  const favoriteIds = isFavoritesCategory ? getFavorites(selectedSourceEntryId, "live") : null
  filteredSourceChannels = allSourceChannels.filter((channel) => {
    if (favoriteIds) {
      if (!favoriteIds.has(channel.id)) return false
    } else if (category && channel.category !== category) {
      return false
    }
    const norm = channel.norm || normalize(`${channel.name || ""} ${channel.category || ""}`)
    return matchesNormQuery(norm, tokens)
  })
  const sortMode = sourceSortSelect?.value || "default"
  if (sortMode === "az" || sortMode === "za") {
    filteredSourceChannels = [...filteredSourceChannels].sort((left, right) => {
      const compared = (left.name || "").localeCompare(right.name || "", undefined, {
        sensitivity: "base",
        numeric: true,
      })
      return sortMode === "az" ? compared : -compared
    })
  } else if (isFavoritesCategory) {
    const orderedFavoriteIds = getFavoritesOrdered(selectedSourceEntryId, "live")
    const orderIndex = new Map(orderedFavoriteIds.map((id, index) => [id, index]))
    filteredSourceChannels = [...filteredSourceChannels].sort(
      (left, right) => (orderIndex.get(left.id) ?? 0) - (orderIndex.get(right.id) ?? 0)
    )
  }
  renderSourceList()
}

let sourceRenderScheduled = false
function scheduleSourceRender(): void {
  if (sourceRenderScheduled) return
  sourceRenderScheduled = true
  requestAnimationFrame(() => {
    sourceRenderScheduled = false
    renderSourceList()
  })
}

function renderSourceList(): void {
  if (!sourceSpacer || !sourceViewport || !sourceListEl) return
  if (!filteredSourceChannels.length) {
    mountSourceEmpty(selectedSourceEntryId ? t("editor.sourceEmpty") : t("editor.selectSourcePrompt"))
    return
  }
  hideSourceEmpty()
  sourceSpacer.style.height = `${filteredSourceChannels.length * ROW_H}px`
  const scrollTop = sourceListEl.scrollTop
  const visibleH = sourceListEl.clientHeight || 400
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - SOURCE_OVERSCAN)
  const endIdx = Math.min(
    filteredSourceChannels.length,
    Math.ceil((scrollTop + visibleH) / ROW_H) + SOURCE_OVERSCAN
  )
  const frag = document.createDocumentFragment()
  for (let idx = startIdx; idx < endIdx; idx++) {
    frag.appendChild(buildSourceRow(filteredSourceChannels[idx], idx))
  }
  sourceViewport.replaceChildren(frag)
  sourceViewport.style.transform = `translateY(${startIdx * ROW_H}px)`
}

/** Identity key for a source-browser row, matching `customSourceKey()`'s shape for the same channel once added. */
function sourceRowKey(channel: any): string | null {
  if (selectedSourceEntryType === "xtream") return `x:${selectedSourceEntryId}:${channel.id}`
  if (selectedSourceEntryType === "m3u" || selectedSourceEntryType === "local-m3u") {
    if (!channel.url) return null
    return `m:${selectedSourceEntryId}:${channel.url}`
  }
  if (selectedSourceEntryType === "custom") {
    const docChannel = sourceDocChannelsById.get(channel.id)
    const source = docChannel && copySourceOf(docChannel)
    return source ? customSourceKey(source) : null
  }
  return null
}

/** Groups already carrying this source key. */
function groupsContainingSourceCount(rowKey: string): number {
  let count = 0
  for (const groupKeys of presentSourceKeysByGroupMap.values()) {
    if (groupKeys.has(rowKey)) count++
  }
  return count
}

function buildSourceRow(channel: any, idx: number): HTMLElement {
  const row = document.createElement("div")
  row.className =
    "flex w-full items-center gap-2.5 px-2.5 cursor-pointer hover:bg-surface-2 focus-visible:bg-surface-2 outline-none"
  row.style.height = `${ROW_H}px`
  row.dataset.idx = String(idx)
  row.tabIndex = 0
  const checked = selectedIds.has(channel.id)
  if (checked) row.classList.add("bg-accent-soft")
  const rowKey = sourceRowKey(channel)
  const addedGroupCount = rowKey ? groupsContainingSourceCount(rowKey) : 0

  const checkbox = document.createElement("input")
  checkbox.type = "checkbox"
  checkbox.className = "size-4 shrink-0"
  checkbox.checked = checked
  checkbox.setAttribute("aria-label", channel.name || "")
  checkbox.addEventListener("click", (event) => {
    event.stopPropagation()
    handleSourceRowClick(idx, event as MouseEvent)
  })

  const info = document.createElement("div")
  info.className = "flex flex-col min-w-0 flex-1"
  const nameEl = document.createElement("div")
  nameEl.className = "truncate text-sm font-medium"
  nameEl.textContent = channel.name || ""
  const metaEl = document.createElement("div")
  metaEl.className = "truncate text-xs text-fg-3"
  metaEl.textContent = channel.category || ""
  info.append(nameEl, metaEl)

  row.append(checkbox, info)

  if (addedGroupCount > 0) {
    const badge = document.createElement("span")
    badge.className = "inline-flex items-center gap-1 shrink-0 text-2xs text-fg-3"
    badge.innerHTML = `${ICON_CHECK}<span>${escapeHtml(tCount("editor.addedInGroups", addedGroupCount))}</span>`
    row.appendChild(badge)
  }

  row.addEventListener("click", (event) => handleSourceRowClick(idx, event as MouseEvent))
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      handleSourceRowClick(idx, event as unknown as MouseEvent)
    }
  })
  return row
}

function handleSourceRowClick(idx: number, event: MouseEvent): void {
  const channel = filteredSourceChannels[idx]
  if (!channel) return
  if (event.shiftKey && lastClickedIndex !== -1) {
    const [start, end] = idx < lastClickedIndex ? [idx, lastClickedIndex] : [lastClickedIndex, idx]
    for (let i = start; i <= end; i++) {
      const target = filteredSourceChannels[i]
      if (target) selectedIds.add(target.id)
    }
  } else {
    if (selectedIds.has(channel.id)) selectedIds.delete(channel.id)
    else selectedIds.add(channel.id)
    lastClickedIndex = idx
  }
  updateSelectedCount()
  renderSourceList()
}

function selectAllFilteredSourceChannels(): void {
  for (const channel of filteredSourceChannels) {
    if (!sourceRowKey(channel)) continue
    selectedIds.add(channel.id)
  }
  lastClickedIndex = -1
  updateSelectedCount()
  renderSourceList()
}

function deselectAllFilteredSourceChannels(): void {
  for (const channel of filteredSourceChannels) selectedIds.delete(channel.id)
  lastClickedIndex = -1
  updateSelectedCount()
  renderSourceList()
}

function buildSourceForChannel(sourceEntry: any, channel: any): CustomSource | null {
  if (sourceEntry.type === "xtream") {
    return { kind: "xtream", entryId: sourceEntry._id, streamId: channel.id }
  }
  if (sourceEntry.type === "m3u" || sourceEntry.type === "local-m3u") {
    if (!channel.url) return null
    return { kind: "m3u", entryId: sourceEntry._id, url: channel.url, name: channel.name || "" }
  }
  if (sourceEntry.type === "custom") {
    const docChannel = sourceDocChannelsById.get(channel.id)
    return docChannel ? copySourceOf(docChannel) : null
  }
  return null
}

function wireFavoritesSync(): void {
  document.addEventListener("xt:favorites-changed", (event) => {
    const detail = (event as CustomEvent).detail
    if (!detail || detail.playlistId !== selectedSourceEntryId || detail.kind !== "live") return
    populateCategoryFilter()
    applySourceFilter()
  })
}

async function addSelectedChannels(): Promise<void> {
  if (!selectedIds.size || !selectedSourceEntryId) return
  const requestedSourceEntryId = selectedSourceEntryId
  const channelsSnapshot = allSourceChannels
  let entries: any[]
  try {
    entries = await getEntries()
  } catch (err) {
    log.warn("[xt:editor] getEntries failed:", err)
    toastError(t("editor.toastLoadFailed"))
    return
  }
  if (selectedSourceEntryId !== requestedSourceEntryId || allSourceChannels !== channelsSnapshot) return
  const sourceEntry = entries.find((entry: any) => entry._id === requestedSourceEntryId)
  if (!sourceEntry) return
  const overrideGroup = sourceTargetGroupInput?.value.trim() || ""
  const seenKeysByGroup = new Map<string, Set<string>>()
  for (const [group, keys] of presentSourceKeysByGroupMap) seenKeysByGroup.set(group, new Set(keys))
  let nextDoc = doc
  let addedCount = 0
  let skippedCount = 0
  for (const channel of channelsSnapshot) {
    if (!selectedIds.has(channel.id)) continue
    const source = buildSourceForChannel(sourceEntry, channel)
    if (!source) continue
    const key = customSourceKey(source)
    const targetGroup = overrideGroup || channel.category || UNCATEGORIZED
    const groupKeys = seenKeysByGroup.get(targetGroup)
    if (groupKeys?.has(key)) {
      skippedCount++
      continue
    }
    if (groupKeys) groupKeys.add(key)
    else seenKeysByGroup.set(targetGroup, new Set([key]))
    const result = addChannel(nextDoc, source, {
      name: channel.name || "",
      logo: channel.logo || null,
      group: overrideGroup || channel.category || null,
      tvgId: channel.tvgId || null,
      chno: channel.chno ?? null,
      catchup: sourceDocChannelsById.get(channel.id)?.catchup ?? null,
    })
    nextDoc = result.doc
    addedCount++
  }
  if (!addedCount && !skippedCount) return
  selectedIds.clear()
  lastClickedIndex = -1
  updateSelectedCount()
  if (addedCount) applyDoc(nextDoc)
  else renderSourceList()
  if (addedCount) toastSuccess(t("editor.toastAdded", { count: addedCount }))
  if (skippedCount) toastWarn(t("editor.toastAlreadyAdded", { count: skippedCount }))
}

// ---------------------------------------------------------------------------
// Mobile pane switcher
// ---------------------------------------------------------------------------
const PANE_TAB_ACTIVE_CLASSES = ["bg-accent-soft", "text-accent", "ring-1", "ring-accent/30"]
const PANE_TAB_IDLE_CLASSES = ["text-fg-2"]

function loadActivePane(): void {
  try {
    const stored = sessionStorage.getItem(PANE_STORAGE_KEY)
    if (stored === "source" || stored === "playlist") activePane = stored
  } catch {
    // sessionStorage unavailable (private browsing etc); keep the default.
  }
}

function updatePaneTabStyles(): void {
  if (paneTabSourceBtn) {
    paneTabSourceBtn.classList.remove(...PANE_TAB_ACTIVE_CLASSES, ...PANE_TAB_IDLE_CLASSES)
    paneTabSourceBtn.classList.add(...(activePane === "source" ? PANE_TAB_ACTIVE_CLASSES : PANE_TAB_IDLE_CLASSES))
    paneTabSourceBtn.setAttribute("aria-selected", String(activePane === "source"))
    paneTabSourceBtn.tabIndex = activePane === "source" ? 0 : -1
  }
  if (paneTabPlaylistBtn) {
    paneTabPlaylistBtn.classList.remove(...PANE_TAB_ACTIVE_CLASSES, ...PANE_TAB_IDLE_CLASSES)
    paneTabPlaylistBtn.classList.add(...(activePane === "playlist" ? PANE_TAB_ACTIVE_CLASSES : PANE_TAB_IDLE_CLASSES))
    paneTabPlaylistBtn.setAttribute("aria-selected", String(activePane === "playlist"))
    paneTabPlaylistBtn.tabIndex = activePane === "playlist" ? 0 : -1
  }
}

function setActivePane(pane: "source" | "playlist"): void {
  activePane = pane
  try {
    sessionStorage.setItem(PANE_STORAGE_KEY, pane)
  } catch {
    // Best-effort only.
  }
  panesEl?.setAttribute("data-active-pane", pane)
  updatePaneTabStyles()
}

function wirePaneSwitcher(): void {
  panesEl?.setAttribute("data-active-pane", activePane)
  updatePaneTabStyles()
  paneTabSourceBtn?.addEventListener("click", () => setActivePane("source"))
  paneTabPlaylistBtn?.addEventListener("click", () => setActivePane("playlist"))
  const tablist = paneTabSourceBtn?.closest<HTMLElement>('[role="tablist"]')
  tablist?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const next = activePane === "source" ? "playlist" : "source"
    setActivePane(next)
    ;(next === "source" ? paneTabSourceBtn : paneTabPlaylistBtn)?.focus()
  })
}

// ---------------------------------------------------------------------------
// Group collapse state
// ---------------------------------------------------------------------------
function loadCollapsedGroups(): void {
  try {
    const raw = sessionStorage.getItem(COLLAPSED_GROUPS_KEY_PREFIX + entryId)
    collapsedGroups = raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    collapsedGroups = new Set()
  }
}

function saveCollapsedGroups(): void {
  try {
    sessionStorage.setItem(COLLAPSED_GROUPS_KEY_PREFIX + entryId, JSON.stringify([...collapsedGroups]))
  } catch {
    // Best-effort only.
  }
}

// ---------------------------------------------------------------------------
// Playlist pane (right)
// ---------------------------------------------------------------------------
function iconButton(svg: string, label: string): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "btn min-h-11 min-w-11 h-11 w-11 p-0 shrink-0"
  btn.innerHTML = svg
  btn.setAttribute("aria-label", label)
  btn.title = label
  return btn
}

function refreshGroupsDatalist(): void {
  if (!groupsDatalist) return
  groupsDatalist.replaceChildren()
  for (const groupName of doc.groups) {
    const option = document.createElement("option")
    option.value = groupName
    groupsDatalist.appendChild(option)
  }
}

// ---------------------------------------------------------------------------
// Focus preservation across full re-renders
// ---------------------------------------------------------------------------
interface FocusSnapshot {
  rowKey?: string
  groupName?: string
  action?: string
}

function captureFocus(): FocusSnapshot | null {
  const active = document.activeElement as HTMLElement | null
  if (!active || !groupsContainer?.contains(active)) return null
  const row = active.closest<HTMLElement>(".editor-channel-row[data-key]")
  if (row?.dataset.key) {
    return { rowKey: row.dataset.key, action: active.dataset.action }
  }
  const section = active.closest<HTMLElement>(".editor-group-section[data-group]")
  if (section?.dataset.group) {
    return { groupName: section.dataset.group, action: active.dataset.action }
  }
  return null
}

function restoreFocus(saved: FocusSnapshot | null): void {
  if (!saved || !groupsContainer) return
  if (saved.rowKey) {
    const row = groupsContainer.querySelector<HTMLElement>(`.editor-channel-row[data-key="${CSS.escape(saved.rowKey)}"]`)
    if (row) {
      const control =
        (saved.action && row.querySelector<HTMLElement>(`[data-action="${CSS.escape(saved.action)}"]`)) ||
        row.querySelector<HTMLElement>('[data-action="more"]')
      control?.focus()
      return
    }
    // Row is gone (removed): fall back to the nearest row's More button.
    groupsContainer.querySelector<HTMLElement>('.editor-channel-row [data-action="more"]')?.focus()
    return
  }
  if (saved.groupName) {
    const section = groupsContainer.querySelector<HTMLElement>(`.editor-group-section[data-group="${CSS.escape(saved.groupName)}"]`)
    if (section) {
      const control =
        (saved.action && section.querySelector<HTMLElement>(`[data-action="${CSS.escape(saved.action)}"]`)) ||
        section.querySelector<HTMLElement>('[data-action="more"]')
      control?.focus()
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering (with signature-keyed row reuse to avoid rebuilding unchanged rows)
// ---------------------------------------------------------------------------
interface ChannelRowRefs {
  el: HTMLElement
  checkbox: HTMLInputElement
  upBtn: HTMLButtonElement
  downBtn: HTMLButtonElement
}
const channelRowCache = new Map<string, { signature: string; refs: ChannelRowRefs }>()

function computeRowSignature(
  channel: CustomChannel,
  resolved: ResolvedCustomChannel | undefined,
  sourceTitle: string | null
): string {
  return JSON.stringify([
    channel.kind ?? null,
    channel.group,
    channel.overrides.name,
    channel.overrides.logo,
    channel.overrides.chno,
    resolved?.name,
    resolved?.logo,
    resolved?.chno,
    resolved?.unresolved ?? false,
    linkCheckStatus.get(channel.key) ?? null,
    sourceTitle,
    doc.groups.length,
  ])
}

function getOrBuildChannelRow(
  channel: CustomChannel,
  resolved: ResolvedCustomChannel | undefined,
  groupSize: number,
  rowIdx: number
): HTMLElement {
  const sourceTitle = sourceTitleForChannel(channel)
  const signature = computeRowSignature(channel, resolved, sourceTitle)
  const cached = channelRowCache.get(channel.key)
  let refs: ChannelRowRefs
  if (cached && cached.signature === signature) {
    refs = cached.refs
  } else {
    refs = buildChannelRow(channel, resolved, sourceTitle)
    channelRowCache.set(channel.key, { signature, refs })
  }
  refs.upBtn.disabled = rowIdx === 0
  refs.downBtn.disabled = rowIdx === groupSize - 1
  const selected = selectedChannelKeys.has(channel.key)
  refs.checkbox.checked = selected
  refs.el.dataset.selected = selected ? "true" : "false"
  return refs.el
}

// Re-anchors an open popover to its row/group's rebuilt element, or closes it if that's gone.
function reconcileOpenMenu(): void {
  if (!menuEl || !groupsContainer) return
  let newAnchor: HTMLElement | null
  if (menuAnchorRowKey) {
    newAnchor = groupsContainer.querySelector<HTMLElement>(
      `.editor-channel-row[data-key="${CSS.escape(menuAnchorRowKey)}"] [data-action="more"]`
    )
  } else if (menuAnchorGroupName) {
    newAnchor = groupsContainer.querySelector<HTMLElement>(
      `.editor-group-section[data-group="${CSS.escape(menuAnchorGroupName)}"] [data-action="more"]`
    )
  } else {
    return
  }
  if (newAnchor) {
    menuReturnFocus = newAnchor
    positionMenu(menuEl, newAnchor)
    return
  }
  closeMenu()
  groupsContainer.querySelector<HTMLElement>(".editor-group-header [data-action=\"more\"]")?.focus()
}

let renderGroupsInProgress = false
let renderGroupsQueued = false

// Defers a re-render requested mid-render (e.g. a blur commit fired by the DOM swap below).
function renderGroups(): void {
  if (renderGroupsInProgress) {
    renderGroupsQueued = true
    return
  }
  renderGroupsInProgress = true
  try {
    renderGroupsNow()
  } finally {
    renderGroupsInProgress = false
    if (renderGroupsQueued) {
      renderGroupsQueued = false
      renderGroups()
    }
  }
}

function renderGroupsNow(): void {
  // The touch drag reads live DOM refs; a re-render mid-drag would strand it, so abort first.
  if (touchDragState) cancelTouchDrag()
  refreshGroupsDatalist()
  if (!groupsContainer || !emptyStateEl) return
  const savedFocus = captureFocus()
  groupsContainer.replaceChildren()
  if (!doc.channels.length) {
    emptyStateEl.classList.remove("hidden")
    emptyStateEl.classList.add("flex")
    channelRowCache.clear()
    reconcileOpenMenu()
    return
  }
  emptyStateEl.classList.add("hidden")
  emptyStateEl.classList.remove("flex")

  const liveKeys = new Set(doc.channels.map((channel) => channel.key))
  for (const key of channelRowCache.keys()) {
    if (!liveKeys.has(key)) channelRowCache.delete(key)
  }

  const resolvedById = new Map<number, ResolvedCustomChannel>()
  for (const resolved of resolvedChannels) resolvedById.set(resolved.id, resolved)

  const byGroup = new Map<string, Array<{ channel: CustomChannel; resolved: ResolvedCustomChannel | undefined }>>()
  for (const channel of orderedChannels) {
    const list = byGroup.get(channel.group) || []
    list.push({ channel, resolved: resolvedById.get(channel.id) })
    byGroup.set(channel.group, list)
  }

  const groupNames = doc.groups.length ? doc.groups : [...byGroup.keys()]
  const frag = document.createDocumentFragment()
  groupNames.forEach((groupName, groupIdx) => {
    const rows = byGroup.get(groupName) || []
    frag.appendChild(buildGroupSection(groupName, rows, groupIdx, groupNames.length))
  })
  groupsContainer.appendChild(frag)
  restoreFocus(savedFocus)
  reconcileOpenMenu()
}

function buildGroupSection(
  groupName: string,
  rows: Array<{ channel: CustomChannel; resolved: ResolvedCustomChannel | undefined }>,
  groupIdx: number,
  groupCount: number
): HTMLElement {
  const section = document.createElement("div")
  section.className = "editor-group-section flex flex-col gap-1.5"
  section.dataset.group = groupName

  const collapsed = collapsedGroups.has(groupName)

  const header = document.createElement("div")
  header.className = "editor-group-header flex items-center gap-1.5"

  const groupChannelKeys = rows.map((row) => row.channel.key)
  const selectGroupCheckbox = document.createElement("input")
  selectGroupCheckbox.type = "checkbox"
  selectGroupCheckbox.className = "size-4 shrink-0"
  selectGroupCheckbox.dataset.action = "select-group"
  selectGroupCheckbox.setAttribute("aria-label", t("editor.selectGroup", { name: groupName }))
  updateGroupSelectCheckbox(selectGroupCheckbox, groupChannelKeys)
  selectGroupCheckbox.addEventListener("click", (event) => {
    event.stopPropagation()
    toggleGroupSelection(groupChannelKeys)
  })

  const collapseBtn = iconButton(
    ICON_CHEVRON_DOWN,
    collapsed ? t("editor.expandGroup") : t("editor.collapseGroup")
  )
  collapseBtn.dataset.action = "collapse"
  collapseBtn.setAttribute("aria-expanded", String(!collapsed))
  const collapseIcon = collapseBtn.querySelector("svg")
  collapseIcon?.classList.add("transition-transform")
  if (collapsed) collapseIcon?.classList.add("-rotate-90")
  collapseBtn.addEventListener("click", () => {
    if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName)
    else collapsedGroups.add(groupName)
    saveCollapsedGroups()
    renderGroups()
  })

  const nameButton = document.createElement("button")
  nameButton.type = "button"
  nameButton.textContent = groupName
  nameButton.className =
    "editor-group-name flex-1 min-w-0 min-h-11 flex items-center rounded-lg px-1.5 -mx-1.5 text-start text-sm font-semibold truncate transition-colors hover:bg-surface-2"
  nameButton.dataset.action = "rename-trigger"
  nameButton.title = t("editor.rename")
  nameButton.setAttribute("aria-label", `${groupName}: ${t("editor.rename")}`)
  // Keyboard activation (Enter/Space) dispatches a click with detail 0; a mouse
  // click has detail >= 1, so only the keyboard path and dblclick enter rename.
  nameButton.addEventListener("click", (event) => {
    if (event.detail === 0) startGroupRename(header, groupName)
  })
  nameButton.addEventListener("dblclick", () => startGroupRename(header, groupName))
  nameButton.addEventListener("keydown", (event) => {
    if (event.key === "F2") {
      event.preventDefault()
      startGroupRename(header, groupName)
    }
  })

  const count = document.createElement("span")
  count.className = "text-2xs text-fg-3 tabular-nums shrink-0"
  count.textContent = String(rows.filter((row) => !isHeaderChannel(row.channel)).length)

  const moreBtn = iconButton(ICON_DOTS_VERTICAL, t("common.moreOptionsAria", { title: groupName }))
  moreBtn.dataset.action = "more"
  moreBtn.addEventListener("click", () => openGroupMenu(moreBtn, groupName, groupIdx, groupCount, groupChannelKeys))

  header.append(selectGroupCheckbox, collapseBtn, nameButton, count, moreBtn)
  addGroupDropHandlers(header, groupName)
  section.appendChild(header)

  if (!collapsed) {
    const list = document.createElement("div")
    list.className = "editor-group flex flex-col gap-1 rounded-lg"
    list.dataset.group = groupName
    rows.forEach((row, rowIdx) => {
      list.appendChild(getOrBuildChannelRow(row.channel, row.resolved, rows.length, rowIdx))
    })
    addGroupDropHandlers(list, groupName)
    section.appendChild(list)
  }

  return section
}

function startGroupRename(header: HTMLElement, groupName: string): void {
  if (header.querySelector('[data-action="rename-input"]')) return
  const nameButton = header.querySelector<HTMLButtonElement>('[data-action="rename-trigger"]')
  if (!nameButton) return
  const input = document.createElement("input")
  input.type = "text"
  input.value = groupName
  input.className = "field-input h-9 flex-1 min-w-0 font-semibold text-sm"
  input.dataset.action = "rename-input"
  input.setAttribute("aria-label", t("editor.groupNameLabel"))
  markInputCommitted(input)
  nameButton.replaceWith(input)
  input.focus()
  input.select()

  let settled = false
  const commit = (): void => {
    if (settled) return
    if (!input.isConnected) return
    settled = true
    const nextName = input.value.trim()
    if (!nextName || nextName === groupName) {
      renderGroups()
      return
    }
    applyDoc(renameGroup(doc, groupName, nextName))
  }
  const cancel = (): void => {
    if (settled) return
    settled = true
    renderGroups()
  }
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      commit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      cancel()
    }
  })
  input.addEventListener("blur", commit)
}

function focusGroupNameInput(groupName: string): void {
  const section = groupsContainer?.querySelector<HTMLElement>(`.editor-group-section[data-group="${CSS.escape(groupName)}"]`)
  const header = section?.querySelector<HTMLElement>(".editor-group-header")
  if (header) startGroupRename(header, groupName)
}

function deleteGroupWithToast(groupName: string): void {
  applyDoc(removeGroup(doc, groupName))
  toastSuccess(t("editor.toastGroupRemoved", { name: groupName }), {
    action: { label: t("common.undo"), onClick: () => undo() },
  })
}

function addHeaderToGroup(groupName: string): void {
  const newId = doc.nextId
  const nextDoc = addHeader(doc, groupName, t("editor.headerDefaultName"))
  applyDoc(nextDoc)
  const header = nextDoc.channels.find((channel) => channel.id === newId && isHeaderChannel(channel))
  if (!header) return
  const row = groupsContainer?.querySelector<HTMLElement>(`.editor-channel-row[data-key="${CSS.escape(header.key)}"]`)
  const nameRow = row?.querySelector<HTMLElement>('[data-role="name-row"]')
  const nameEl = row?.querySelector<HTMLElement>('[data-role="name-text"]')
  if (nameRow && nameEl) startRowRename(nameRow, nameEl, header)
}

function openGroupMenu(
  anchor: HTMLButtonElement,
  groupName: string,
  groupIdx: number,
  groupCount: number,
  groupChannelKeys: string[]
): void {
  const allSelected = groupChannelKeys.length > 0 && groupChannelKeys.every((key) => selectedChannelKeys.has(key))
  const anySelected = groupChannelKeys.some((key) => selectedChannelKeys.has(key))
  const items: MenuItemDef[] = [
    { key: "rename", label: t("editor.rename"), onClick: () => focusGroupNameInput(groupName) },
    { key: "add-header", label: t("editor.addHeader"), onClick: () => addHeaderToGroup(groupName) },
    {
      key: "up",
      label: t("editor.moveGroupUp"),
      disabled: groupIdx === 0,
      onClick: () => applyDoc(reorderGroupPosition(doc, groupName, "up")),
    },
    {
      key: "down",
      label: t("editor.moveGroupDown"),
      disabled: groupIdx === groupCount - 1,
      onClick: () => applyDoc(reorderGroupPosition(doc, groupName, "down")),
    },
    {
      key: "select-all",
      label: t("editor.selectGroup", { name: groupName }),
      disabled: !groupChannelKeys.length || allSelected,
      onClick: () => selectGroupChannels(groupChannelKeys),
    },
    {
      key: "deselect-all",
      label: t("editor.deselectGroup", { name: groupName }),
      disabled: !anySelected,
      onClick: () => deselectGroupChannels(groupChannelKeys),
    },
    {
      key: "sort-az",
      label: t("editor.sortAz"),
      separatorBefore: true,
      disabled: nonHeaderKeysIn(groupChannelKeys).length < 2,
      onClick: () => sortChannelsWithToast(nonHeaderKeysIn(groupChannelKeys), "asc"),
    },
    {
      key: "sort-za",
      label: t("editor.sortZa"),
      disabled: nonHeaderKeysIn(groupChannelKeys).length < 2,
      onClick: () => sortChannelsWithToast(nonHeaderKeysIn(groupChannelKeys), "desc"),
    },
    { key: "delete", label: t("editor.deleteGroup"), destructive: true, separatorBefore: true, onClick: () => deleteGroupWithToast(groupName) },
  ]
  openMenu(anchor, items, t("common.moreOptionsAria", { title: groupName }))
  menuAnchorGroupName = groupName
}

// A block drag encodes its keys as a JSON array; a single-row drag is just the plain key string.
function parseDraggedKeys(dataTransfer: DataTransfer | null): string[] {
  const raw = dataTransfer?.getData("text/plain")
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string")
  } catch {
    // Not JSON: a single plain key.
  }
  return [raw]
}

// Single chokepoint for applying a resolved drop: shared by the mouse HTML5 path and the touch pointer path below.
function applyChannelDrop(draggedKeys: string[], beforeKey: string | null, group: string): void {
  if (!draggedKeys.length) return
  if (beforeKey && draggedKeys.includes(beforeKey)) return
  applyDoc(moveChannels(doc, draggedKeys, beforeKey, group))
}

function addGroupDropHandlers(listEl: HTMLElement, groupName: string): void {
  listEl.addEventListener("dragover", (event) => {
    event.preventDefault()
    if (event.target === listEl) listEl.dataset.dropTarget = "true"
  })
  listEl.addEventListener("dragleave", (event) => {
    if (event.target === listEl) listEl.dataset.dropTarget = "false"
  })
  listEl.addEventListener("drop", (event) => {
    listEl.dataset.dropTarget = "false"
    if (event.target !== listEl) return
    event.preventDefault()
    applyChannelDrop(parseDraggedKeys(event.dataTransfer), null, groupName)
  })
}

// ---------------------------------------------------------------------------
// Touch pointer drag-and-drop (coarse pointers only; the HTML5 DnD above stays mouse-only)
// ---------------------------------------------------------------------------
const TOUCH_LONG_PRESS_MS = 350
const TOUCH_MOVE_CANCEL_PX = 8
const TOUCH_AUTOSCROLL_EDGE_PX = 48
const TOUCH_AUTOSCROLL_MAX_PX = 16

interface PendingLongPress {
  pointerId: number
  startX: number
  startY: number
  timer: ReturnType<typeof setTimeout>
}

interface TouchDragState {
  pointerId: number
  row: HTMLElement
  draggedKeys: string[]
  scrollContainer: HTMLElement
  dropTargetEl: HTMLElement | null
  autoScrollFrame: number | null
  ghostEl: HTMLElement
  grabOffsetX: number
  grabOffsetY: number
}

let pendingLongPress: PendingLongPress | null = null
let touchDragState: TouchDragState | null = null

function clearPendingLongPress(): void {
  if (!pendingLongPress) return
  clearTimeout(pendingLongPress.timer)
  pendingLongPress = null
}

function isInteractiveDragTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("input, button, a, select, textarea")
}

// Walks up to the nearest scrollable ancestor, falling back to the document (the right pane
// only scrolls internally at the lg breakpoint; below that the whole page scrolls instead).
function findScrollableAncestor(startEl: HTMLElement): HTMLElement {
  let node: HTMLElement | null = startEl.parentElement
  while (node && node !== document.body) {
    const style = getComputedStyle(node)
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) || document.documentElement
}

function setDraggedRowsVisual(keys: string[], dragging: boolean): void {
  for (const key of keys) {
    const cached = channelRowCache.get(key)
    if (cached) cached.refs.el.dataset.dragging = dragging ? "true" : "false"
  }
}

const TOUCH_DRAG_GHOST_SCALE = 1.02
const TOUCH_DRAG_GHOST_ENTRANCE_MS = 160

// Neutralizes every focusable/clickable descendant of the ghost clone; the ghost is decorative
// only, real interaction still targets the source row underneath.
function makeGhostControlsInert(ghostEl: HTMLElement): void {
  for (const control of ghostEl.querySelectorAll<HTMLElement>("input, button, a, select, textarea")) {
    control.style.pointerEvents = "none"
    control.setAttribute("aria-hidden", "true")
    control.setAttribute("inert", "")
  }
}

function createTouchDragGhost(row: HTMLElement, rowRect: DOMRect, draggedCount: number): HTMLElement {
  const ghostEl = row.cloneNode(true) as HTMLElement
  ghostEl.removeAttribute("id")
  ghostEl.removeAttribute("data-key")
  ghostEl.className = `${row.className} editor-drag-ghost`
  ghostEl.style.width = `${rowRect.width}px`
  ghostEl.setAttribute("aria-hidden", "true")
  ghostEl.setAttribute("inert", "")
  makeGhostControlsInert(ghostEl)
  if (draggedCount > 1) {
    const badge = document.createElement("span")
    badge.className = "editor-drag-ghost-badge"
    badge.textContent = t("editor.selectedCount", { count: draggedCount })
    ghostEl.appendChild(badge)
  }
  return ghostEl
}

function positionTouchDragGhost(ghostEl: HTMLElement, clientX: number, clientY: number, scale: number): void {
  ghostEl.style.transform = `translate3d(${clientX}px, ${clientY}px, 0) scale(${scale})`
}

function updateTouchDragGhost(state: TouchDragState, clientX: number, clientY: number): void {
  positionTouchDragGhost(state.ghostEl, clientX - state.grabOffsetX, clientY - state.grabOffsetY, TOUCH_DRAG_GHOST_SCALE)
}

// Same target shape mouse dragover resolves per-row/per-group, computed instead via hit-testing
// since a custom pointer drag has no native drop target.
function resolveTouchDropTarget(
  clientX: number,
  clientY: number
): { beforeKey: string | null; group: string; el: HTMLElement } | null {
  const elementAtPoint = document.elementFromPoint(clientX, clientY)
  if (!elementAtPoint) return null
  const rowEl = elementAtPoint.closest<HTMLElement>(".editor-channel-row[data-key]")
  if (rowEl?.dataset.key) {
    const targetChannel = doc.channels.find((channel) => channel.key === rowEl.dataset.key)
    if (!targetChannel) return null
    const rect = rowEl.getBoundingClientRect()
    if (clientY <= rect.top + rect.height / 2) {
      return { beforeKey: targetChannel.key, group: targetChannel.group, el: rowEl }
    }
    const groupOrder = orderedChannels.filter((channel) => channel.group === targetChannel.group)
    const targetIndex = groupOrder.findIndex((channel) => channel.key === targetChannel.key)
    const nextChannel = groupOrder[targetIndex + 1]
    return { beforeKey: nextChannel ? nextChannel.key : null, group: targetChannel.group, el: rowEl }
  }
  const sectionEl = elementAtPoint.closest<HTMLElement>(".editor-group-section[data-group]")
  if (sectionEl?.dataset.group) {
    const header = sectionEl.querySelector<HTMLElement>(".editor-group-header")
    return { beforeKey: null, group: sectionEl.dataset.group, el: header || sectionEl }
  }
  return null
}

function setTouchDropIndicator(state: TouchDragState, target: { el: HTMLElement } | null): void {
  const nextEl = target?.el ?? null
  if (state.dropTargetEl === nextEl) return
  if (state.dropTargetEl) state.dropTargetEl.dataset.dropTarget = "false"
  state.dropTargetEl = nextEl
  if (nextEl) nextEl.dataset.dropTarget = "true"
}

function stopTouchAutoScroll(state: TouchDragState): void {
  if (state.autoScrollFrame == null) return
  cancelAnimationFrame(state.autoScrollFrame)
  state.autoScrollFrame = null
}

function runTouchAutoScroll(state: TouchDragState, clientY: number): void {
  const container = state.scrollContainer
  const isViewportScroll = container === document.scrollingElement || container === document.documentElement
  const top = isViewportScroll ? 0 : container.getBoundingClientRect().top
  const bottom = isViewportScroll ? window.innerHeight : container.getBoundingClientRect().bottom
  let delta = 0
  if (clientY < top + TOUCH_AUTOSCROLL_EDGE_PX) {
    delta = -TOUCH_AUTOSCROLL_MAX_PX * (1 - Math.max(0, clientY - top) / TOUCH_AUTOSCROLL_EDGE_PX)
  } else if (clientY > bottom - TOUCH_AUTOSCROLL_EDGE_PX) {
    delta = TOUCH_AUTOSCROLL_MAX_PX * (1 - Math.max(0, bottom - clientY) / TOUCH_AUTOSCROLL_EDGE_PX)
  }
  stopTouchAutoScroll(state)
  if (delta === 0) return
  const step = (): void => {
    if (touchDragState !== state) return
    container.scrollTop += delta
    state.autoScrollFrame = requestAnimationFrame(step)
  }
  state.autoScrollFrame = requestAnimationFrame(step)
}

function onTouchDragKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !touchDragState) return
  event.preventDefault()
  event.stopPropagation()
  cancelTouchDrag()
}

function cancelTouchDrag(): void {
  const state = touchDragState
  if (!state) return
  touchDragState = null
  stopTouchAutoScroll(state)
  setDraggedRowsVisual(state.draggedKeys, false)
  if (state.dropTargetEl) state.dropTargetEl.dataset.dropTarget = "false"
  state.row.style.touchAction = ""
  if (state.row.hasPointerCapture(state.pointerId)) state.row.releasePointerCapture(state.pointerId)
  document.removeEventListener("keydown", onTouchDragKeydown, true)
  state.ghostEl.remove()
}

function beginTouchDrag(pointerId: number, row: HTMLElement, channelKey: string, clientX: number, clientY: number): void {
  const channel = doc.channels.find((item) => item.key === channelKey)
  if (!channel) return
  const draggedKeys = selectedChannelKeys.has(channelKey) ? [...selectedChannelKeys] : [channelKey]
  const rowRect = row.getBoundingClientRect()
  const grabOffsetX = clientX - rowRect.left
  const grabOffsetY = clientY - rowRect.top
  const ghostEl = createTouchDragGhost(row, rowRect, draggedKeys.length)
  document.body.appendChild(ghostEl)
  positionTouchDragGhost(ghostEl, clientX - grabOffsetX, clientY - grabOffsetY, 1)
  // Bump to the settled scale/shadow on the next frame so the pickup transitions in, then drop the
  // transition once it lands so later drag moves track the finger 1:1 instead of easing behind it.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ghostEl.classList.add("editor-drag-ghost--lifted")
      positionTouchDragGhost(ghostEl, clientX - grabOffsetX, clientY - grabOffsetY, TOUCH_DRAG_GHOST_SCALE)
    })
  })
  setTimeout(() => { ghostEl.style.transition = "none" }, TOUCH_DRAG_GHOST_ENTRANCE_MS)
  row.setPointerCapture(pointerId)
  row.style.touchAction = "none"
  setDraggedRowsVisual(draggedKeys, true)
  navigator.vibrate?.(10)
  touchDragState = {
    pointerId,
    row,
    draggedKeys,
    scrollContainer: findScrollableAncestor(row),
    dropTargetEl: null,
    autoScrollFrame: null,
    ghostEl,
    grabOffsetX,
    grabOffsetY,
  }
  document.addEventListener("keydown", onTouchDragKeydown, true)
}

function finishTouchDrag(clientX: number, clientY: number): void {
  const state = touchDragState
  if (!state) return
  const target = resolveTouchDropTarget(clientX, clientY)
  const draggedKeys = state.draggedKeys
  cancelTouchDrag()
  if (!target) return
  applyChannelDrop(draggedKeys, target.beforeKey, target.group)
}

function suppressNextRowClick(row: HTMLElement): void {
  const onClick = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    row.removeEventListener("click", onClick, true)
  }
  row.addEventListener("click", onClick, true)
  setTimeout(() => row.removeEventListener("click", onClick, true), 0)
}

function attachTouchReorderHandlers(row: HTMLElement, channel: CustomChannel): void {
  row.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || event.button !== 0) return
    if (isInteractiveDragTarget(event.target)) return
    if (touchDragState || pendingLongPress) return
    const pointerId = event.pointerId
    const timer = setTimeout(() => {
      if (!pendingLongPress || pendingLongPress.pointerId !== pointerId) return
      pendingLongPress = null
      beginTouchDrag(pointerId, row, channel.key, event.clientX, event.clientY)
    }, TOUCH_LONG_PRESS_MS)
    pendingLongPress = { pointerId, startX: event.clientX, startY: event.clientY, timer }
  })

  row.addEventListener("pointermove", (event) => {
    if (pendingLongPress && pendingLongPress.pointerId === event.pointerId) {
      const deltaX = event.clientX - pendingLongPress.startX
      const deltaY = event.clientY - pendingLongPress.startY
      if (Math.hypot(deltaX, deltaY) > TOUCH_MOVE_CANCEL_PX) clearPendingLongPress()
      return
    }
    if (!touchDragState || touchDragState.pointerId !== event.pointerId) return
    event.preventDefault()
    updateTouchDragGhost(touchDragState, event.clientX, event.clientY)
    const target = resolveTouchDropTarget(event.clientX, event.clientY)
    setTouchDropIndicator(touchDragState, target)
    runTouchAutoScroll(touchDragState, event.clientY)
  })

  row.addEventListener("pointerup", (event) => {
    if (pendingLongPress && pendingLongPress.pointerId === event.pointerId) {
      clearPendingLongPress()
      return
    }
    if (!touchDragState || touchDragState.pointerId !== event.pointerId) return
    suppressNextRowClick(row)
    finishTouchDrag(event.clientX, event.clientY)
  })

  row.addEventListener("pointercancel", (event) => {
    if (pendingLongPress && pendingLongPress.pointerId === event.pointerId) {
      clearPendingLongPress()
      return
    }
    if (!touchDragState || touchDragState.pointerId !== event.pointerId) return
    cancelTouchDrag()
  })
}

type MetaSegment = { text: string } | { dotClass: string; label: string }

// Link-check status renders inline in the meta line (dot + label) instead of a
// leading row slot, so a check never shifts the name's x position.
function buildMetaSegments(
  channel: CustomChannel,
  resolved: ResolvedCustomChannel | undefined,
  sourceTitle: string | null,
  status: LinkCheckStatus | undefined
): MetaSegment[] {
  if (isHeaderChannel(channel)) return []
  const segments: MetaSegment[] = []
  const chno = channel.overrides.chno ?? resolved?.chno
  if (chno != null) segments.push({ text: String(chno) })
  if (resolved?.unresolved) {
    segments.push({
      text: sourceTitle
        ? t("editor.unresolvedFromSource", { source: sourceTitle })
        : t("editor.unresolvedSourceRemoved"),
    })
  } else if (sourceTitle) {
    segments.push({ text: sourceTitle })
  }
  if (status) {
    const dotClass =
      status === "pending"
        ? "rounded-full border border-fg-3 animate-pulse"
        : status === "ok"
          ? "rounded-full bg-ok"
          : status === "fail"
            ? "rotate-45 rounded-xs bg-bad"
            : "rounded-full border-2 border-warn"
    const labelKey =
      status === "pending"
        ? "editor.linkStatusChecking"
        : status === "ok"
          ? "editor.linkStatusOk"
          : status === "fail"
            ? "editor.linkStatusFail"
            : "editor.linkStatusUnchecked"
    segments.push({ dotClass, label: t(labelKey) })
  }
  return segments
}

function startRowRename(nameRow: HTMLElement, nameEl: HTMLElement, channel: CustomChannel): void {
  if (nameRow.querySelector("input")) return
  const input = document.createElement("input")
  input.type = "text"
  input.value = channel.overrides.name ?? ""
  input.className = "field-input h-8 flex-1 min-w-0 text-sm py-0"
  input.setAttribute("aria-label", t("editor.nameLabel"))
  input.dataset.action = "rename-input"
  markInputCommitted(input)
  nameEl.replaceWith(input)
  input.focus()
  input.select()

  let settled = false
  const commit = (): void => {
    if (settled) return
    if (!input.isConnected) return
    settled = true
    const value = input.value.trim() || null
    if (value === (channel.overrides.name ?? null)) return
    applyDoc(setOverrides(doc, channel.key, { name: value }))
  }
  const cancel = (): void => {
    if (settled) return
    settled = true
    input.replaceWith(nameEl)
  }
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      commit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      cancel()
    }
  })
  input.addEventListener("blur", commit)
}

function removeChannelWithUndo(channel: CustomChannel, displayName: string): void {
  applyDoc(removeChannels(doc, [channel.key]))
  toastSuccess(t("editor.toastChannelRemoved", { name: displayName || t("common.untitled") }), {
    action: { label: t("common.undo"), onClick: () => undo() },
  })
}

function openMoveToGroupMenu(trigger: HTMLButtonElement, channel: CustomChannel): void {
  const items: MenuItemDef[] = [
    { key: "back", label: t("common.back"), onClick: () => openRowMenu(trigger, channel) },
  ]
  for (const [index, group] of doc.groups.entries()) {
    items.push({
      key: `group:${index}`,
      label: group,
      disabled: group === channel.group,
      onClick: () => applyDoc(moveChannel(doc, channel.key, null, group)),
    })
  }
  openMenu(trigger, items, t("editor.moveToGroupLabel"))
  menuAnchorRowKey = channel.key
}

// When the opened row is part of a multi-selection, the menu acts on the whole selection instead of just this row.
function openBulkRowMenu(trigger: HTMLButtonElement, anchorKey: string): void {
  const keys = [...selectedChannelKeys]
  const items: MenuItemDef[] = [
    {
      key: "move-up",
      label: t("editor.moveUp"),
      disabled: moveChannelsWithinGroup(doc, keys, "up") === doc,
      onClick: () => applyDoc(moveChannelsWithinGroup(doc, keys, "up")),
    },
    {
      key: "move-down",
      label: t("editor.moveDown"),
      disabled: moveChannelsWithinGroup(doc, keys, "down") === doc,
      onClick: () => applyDoc(moveChannelsWithinGroup(doc, keys, "down")),
    },
    {
      key: "move-to-group",
      label: t("editor.moveToGroupLabel"),
      disabled: doc.groups.length < 2,
      onClick: () => openBulkMoveToGroupMenu(trigger),
    },
    {
      key: "sort-az",
      label: t("editor.sortAz"),
      separatorBefore: true,
      disabled: nonHeaderKeysIn(keys).length < 2,
      onClick: () => sortChannelsWithToast(nonHeaderKeysIn(keys), "asc"),
    },
    {
      key: "sort-za",
      label: t("editor.sortZa"),
      disabled: nonHeaderKeysIn(keys).length < 2,
      onClick: () => sortChannelsWithToast(nonHeaderKeysIn(keys), "desc"),
    },
    {
      key: "reset-name",
      label: t("editor.resetName"),
      disabled: !nameOverrideKeysIn(keys).length,
      onClick: () => resetNamesWithToast(nameOverrideKeysIn(keys)),
    },
    {
      key: "remove",
      label: t("editor.removeSelected"),
      destructive: true,
      separatorBefore: true,
      onClick: () => void removeSelectedChannelsWithUndo(),
    },
    { key: "clear", label: t("editor.clearSelection"), separatorBefore: true, onClick: () => clearSelection() },
  ]
  openMenu(trigger, items, t("common.moreOptionsAria", { title: t("editor.selectedCount", { count: keys.length }) }))
  menuAnchorRowKey = anchorKey
}

function openRowMenu(trigger: HTMLButtonElement, channel: CustomChannel): void {
  if (selectedChannelKeys.size > 1 && selectedChannelKeys.has(channel.key)) {
    openBulkRowMenu(trigger, channel.key)
    return
  }
  const isHeader = isHeaderChannel(channel)
  const resolved = findResolved(channel)
  const displayName = channel.overrides.name ?? resolved?.name ?? ""
  const items: MenuItemDef[] = []
  if (isHeader || !resolved?.unresolved) {
    items.push({
      key: "rename",
      label: t("editor.rename"),
      onClick: () => {
        const row = trigger.closest<HTMLElement>(".editor-channel-row")
        const nameRow = row?.querySelector<HTMLElement>('[data-role="name-row"]')
        const nameEl = row?.querySelector<HTMLElement>('[data-role="name-text"]')
        if (nameRow && nameEl) startRowRename(nameRow, nameEl, channel)
      },
    })
  }
  if (!isHeader && !resolved?.unresolved && channel.overrides.name != null) {
    items.push({
      key: "reset-name",
      label: t("editor.resetName"),
      onClick: () => resetNamesWithToast([channel.key]),
    })
  }
  items.push({
    key: "move",
    label: t("editor.moveToGroupLabel"),
    disabled: doc.groups.length < 2,
    onClick: () => openMoveToGroupMenu(trigger, channel),
  })
  if (!isHeader && !resolved?.unresolved) {
    items.push({ key: "edit", label: t("editor.editDetails"), onClick: () => void openEditDialog(channel) })
  }
  items.push({
    key: "remove",
    label: isHeader ? t("editor.removeHeader") : t("editor.removeChannel"),
    destructive: true,
    onClick: () => removeChannelWithUndo(channel, displayName),
  })
  openMenu(trigger, items, t("common.moreOptionsAria", { title: displayName || t("common.untitled") }))
  menuAnchorRowKey = channel.key
}

function buildChannelRow(
  channel: CustomChannel,
  resolved: ResolvedCustomChannel | undefined,
  sourceTitle: string | null
): ChannelRowRefs {
  const isHeader = isHeaderChannel(channel)
  const row = document.createElement("div")
  row.className = isHeader
    ? "editor-channel-row editor-header-row flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-2 py-1.5"
    : "editor-channel-row flex items-center gap-2 rounded-lg border border-line bg-bg px-2 py-1.5"
  row.dataset.key = channel.key
  if (isHeader) row.dataset.kind = "header"

  const displayName = channel.overrides.name ?? resolved?.name ?? ""

  const checkbox = document.createElement("input")
  checkbox.type = "checkbox"
  checkbox.className = "size-4 shrink-0"
  checkbox.checked = selectedChannelKeys.has(channel.key)
  checkbox.setAttribute("aria-label", displayName || t("common.untitled"))
  checkbox.addEventListener("mousedown", (event) => event.stopPropagation())
  checkbox.addEventListener("click", (event) => {
    event.stopPropagation()
    handleChannelRowSelectClick(channel, event as MouseEvent)
  })
  row.appendChild(checkbox)
  row.dataset.selected = checkbox.checked ? "true" : "false"

  // Fine pointers get HTML5 DnD (below); coarse pointers get pointer-based long-press dragging instead.
  const isCoarsePointer = matchMedia("(pointer: coarse)").matches
  row.draggable = !isCoarsePointer
  const grip = document.createElement("span")
  grip.className = "text-fg-3 shrink-0 inline-flex cursor-grab"
  grip.innerHTML = ICON_GRIP_VERTICAL
  grip.setAttribute("aria-hidden", "true")
  grip.tabIndex = -1
  grip.title = t("editor.dragHandleLabel")
  row.appendChild(grip)
  if (isCoarsePointer) attachTouchReorderHandlers(row, channel)

  const logoUrl = resolved?.logo || channel.overrides.logo
  if (!isHeader && logoUrl) {
    const logo = document.createElement("div")
    logo.className =
      "h-8 w-8 shrink-0 rounded overflow-hidden ring-1 ring-inset ring-line bg-surface-2 flex items-center justify-center"
    const img = document.createElement("img")
    img.alt = ""
    img.loading = "lazy"
    img.referrerPolicy = "no-referrer"
    img.className = "h-full w-full object-contain"
    img.onerror = () => img.remove()
    logo.appendChild(img)
    mountCachedImage(img, logoUrl, "logo")
    row.appendChild(logo)
  }

  const nameWrap = document.createElement("div")
  nameWrap.className = isHeader
    ? "flex flex-col min-w-0 flex-1 gap-0.5 border-s-2 border-line ps-2"
    : "flex flex-col min-w-0 flex-1 gap-0.5"

  const nameRow = document.createElement("div")
  nameRow.className = "flex items-center gap-1.5 min-w-0"
  nameRow.dataset.role = "name-row"

  const nameEl = document.createElement("span")
  nameEl.className = isHeader
    ? "truncate text-2xs font-semibold uppercase tracking-wide text-fg-3"
    : "truncate text-sm font-medium"
  nameEl.textContent = displayName || t("common.untitled")
  nameEl.dataset.role = "name-text"
  nameRow.appendChild(nameEl)

  if (resolved?.unresolved) {
    const badge = document.createElement("span")
    badge.className = "shrink-0 rounded-md border border-line bg-surface-2 px-1.5 text-2xs text-fg-3"
    badge.textContent = t("editor.unresolvedBadge")
    nameRow.appendChild(badge)
  }
  nameWrap.appendChild(nameRow)

  const metaSegments = buildMetaSegments(channel, resolved, sourceTitle, linkCheckStatus.get(channel.key))
  if (metaSegments.length) {
    const metaEl = document.createElement("div")
    metaEl.className = "truncate text-2xs text-fg-3"
    metaSegments.forEach((segment, index) => {
      if (index > 0) metaEl.append(" · ")
      if ("text" in segment) {
        metaEl.append(segment.text)
        return
      }
      const statusWrap = document.createElement("span")
      statusWrap.className = "inline-flex items-center gap-1"
      const statusDot = document.createElement("span")
      statusDot.className = `size-2 shrink-0 ${segment.dotClass}`
      statusDot.setAttribute("aria-hidden", "true")
      statusWrap.append(statusDot, segment.label)
      metaEl.appendChild(statusWrap)
    })
    nameWrap.appendChild(metaEl)
  }
  row.appendChild(nameWrap)

  const upBtn = iconButton(ICON_ARROW_UP, t("editor.moveUp"))
  upBtn.dataset.action = "moveUp"
  upBtn.addEventListener("click", () => applyDoc(moveChannelWithinGroup(doc, channel.key, "up")))
  row.appendChild(upBtn)

  const downBtn = iconButton(ICON_ARROW_DOWN, t("editor.moveDown"))
  downBtn.dataset.action = "moveDown"
  downBtn.addEventListener("click", () => applyDoc(moveChannelWithinGroup(doc, channel.key, "down")))
  row.appendChild(downBtn)

  const moreBtn = iconButton(ICON_DOTS_VERTICAL, t("common.moreOptionsAria", { title: displayName || t("common.untitled") }))
  moreBtn.dataset.action = "more"
  moreBtn.addEventListener("click", () => openRowMenu(moreBtn, channel))
  row.appendChild(moreBtn)

  row.addEventListener("contextmenu", (event) => {
    if ((event.target as HTMLElement)?.closest("input, textarea")) return
    event.preventDefault()
    openRowMenu(moreBtn, channel)
  })

  row.addEventListener("dragstart", (event) => {
    if ((event.target as HTMLElement)?.closest("input[type=checkbox]")) {
      event.preventDefault()
      return
    }
    const draggedKeys = selectedChannelKeys.has(channel.key) ? [...selectedChannelKeys] : [channel.key]
    for (const key of draggedKeys) {
      const cached = channelRowCache.get(key)
      if (cached) cached.refs.el.dataset.dragging = "true"
    }
    event.dataTransfer?.setData("text/plain", draggedKeys.length > 1 ? JSON.stringify(draggedKeys) : draggedKeys[0])
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
  })
  row.addEventListener("dragend", () => {
    for (const cached of channelRowCache.values()) {
      if (cached.refs.el.dataset.dragging === "true") cached.refs.el.dataset.dragging = "false"
    }
  })
  row.addEventListener("dragover", (event) => {
    event.preventDefault()
    row.dataset.dropTarget = "true"
  })
  row.addEventListener("dragleave", () => {
    row.dataset.dropTarget = "false"
  })
  row.addEventListener("drop", (event) => {
    event.preventDefault()
    event.stopPropagation()
    row.dataset.dropTarget = "false"
    applyChannelDrop(parseDraggedKeys(event.dataTransfer), channel.key, channel.group)
  })

  return { el: row, checkbox, upBtn, downBtn }
}

async function openEditDialog(channel: CustomChannel): Promise<void> {
  const resolved = findResolved(channel)
  const result = await openCustomChannelEditDialog({
    channel,
    resolvedName: resolved?.name || "",
    resolvedLogo: resolved?.logo ?? null,
    catchup: { value: channel.catchup ?? null },
  })
  if (!result) return
  let nextDoc = setOverrides(doc, channel.key, result.overrides)
  if (result.catchup !== undefined) nextDoc = setCatchup(nextDoc, channel.key, result.catchup)
  applyDoc(nextDoc)
}

// ---------------------------------------------------------------------------
// Remove unavailable (unresolved) channels
// ---------------------------------------------------------------------------
function removeUnavailableChannels(): void {
  const unresolvedKeys = doc.channels
    .filter((channel) => findResolved(channel)?.unresolved)
    .map((channel) => channel.key)
  if (!unresolvedKeys.length) return
  applyDoc(removeChannels(doc, unresolvedKeys))
  toastSuccess(tCount("editor.toastUnavailableRemoved", unresolvedKeys.length), {
    action: { label: t("common.undo"), onClick: () => undo() },
  })
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
async function exportPlaylist(): Promise<void> {
  if (!customEntry || exportRunning) return
  exportRunning = true
  try {
    await flushSave()
    const { entries, skippedCount } = await buildM3UEntriesForEntry(customEntry)
    if (!entries.length) {
      toastError(t("editor.toastExportEmpty"))
      return
    }
    const text = serializeM3U(entries, { epgUrl: customEntry.epgUrl || null })
    const filename = `${sanitizeFilename(customEntry.title || "playlist")}.m3u`
    const outcome = await saveM3UText(filename, text)
    if (outcome.cancelled) return
    toastSuccess(t("editor.toastExportDone"), { description: outcome.savedTo || undefined })
    if (skippedCount > 0) toastWarn(t("editor.toastExportSkipped", { count: skippedCount }))
  } catch (err) {
    log.warn("[xt:editor] export failed:", err)
    toastError(t("editor.toastExportFail"), { description: (err as any)?.message })
  } finally {
    exportRunning = false
  }
}

function focusGroupSection(groupName: string): void {
  const section = groupsContainer?.querySelector<HTMLElement>(`.editor-group-section[data-group="${CSS.escape(groupName)}"]`)
  section?.scrollIntoView({ behavior: "smooth", block: "center" })
  section?.querySelector<HTMLInputElement>("input")?.focus()
}

// ---------------------------------------------------------------------------
// Dialog wiring
// ---------------------------------------------------------------------------
function wireNewGroupDialog(): void {
  if (!newGroupBtn || !newGroupDialog || !newGroupNameInput) return
  attachDialogSpatialNav(newGroupDialog, { defaultElement: "#editor-new-group-name" })
  newGroupBtn.addEventListener("click", () => {
    newGroupNameInput.value = ""
    newGroupDialog.showModal()
  })
  newGroupDialog.querySelector('[data-role="cancel"]')?.addEventListener("click", () => newGroupDialog.close())
  newGroupDialog.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault()
    const name = newGroupNameInput.value.trim()
    newGroupDialog.close()
    if (!name) return
    if (doc.groups.includes(name)) {
      toastWarn(t("editor.toastGroupExists", { name }))
      focusGroupSection(name)
      return
    }
    applyDoc(withNewGroup(doc, name))
    toastSuccess(t("editor.toastGroupCreated", { name }))
  })
}

function wireAddUrlDialog(): void {
  if (!addUrlBtn || !addUrlDialog) return
  attachDialogSpatialNav(addUrlDialog, { defaultElement: "#editor-url-url" })
  addUrlBtn.addEventListener("click", () => {
    addUrlDialog.querySelector("form")?.reset()
    urlErrorEl?.classList.add("hidden")
    if (urlManifestSelect) urlManifestSelect.value = ""
    addUrlDialog.showModal()
  })
  addUrlDialog.querySelector('[data-role="cancel"]')?.addEventListener("click", () => addUrlDialog.close())
  addUrlDialog.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault()
    const raw = (urlUrlInput?.value || "").trim()
    let parsed: URL | null
    try {
      parsed = new URL(raw)
    } catch {
      parsed = null
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      if (urlErrorEl) {
        urlErrorEl.textContent = t("editor.addUrlError")
        urlErrorEl.classList.remove("hidden")
      }
      return
    }
    const name = urlNameInput?.value.trim() || parsed.hostname
    const group = urlGroupInput?.value.trim() || null
    const logo = urlLogoInput?.value.trim() || null
    const userAgent = urlUaInput?.value.trim() || null
    const referer = urlRefererInput?.value.trim() || null
    const licenseKey = urlLicenseInput?.value.trim() || null
    const manifestType = urlManifestSelect?.value || null
    const source: CustomSource = {
      kind: "direct",
      url: parsed.href,
      userAgent,
      referer,
      manifestType,
      drmScheme: licenseKey ? "clearkey" : null,
      licenseKey,
    }
    if (presentSourceKeySet.has(customSourceKey(source))) {
      addUrlDialog.close()
      toastWarn(t("editor.toastAlreadyAdded", { count: 1 }))
      return
    }
    const result = addChannel(doc, source, { name, logo, group })
    applyDoc(result.doc)
    addUrlDialog.close()
    toastSuccess(t("editor.toastUrlAdded"))
  })
}

// ---------------------------------------------------------------------------
// Bulk rename (find/replace)
// ---------------------------------------------------------------------------
function effectiveChannelName(channel: CustomChannel, resolvedById: Map<number, ResolvedCustomChannel>): string {
  return channel.overrides.name ?? resolvedById.get(channel.id)?.name ?? ""
}

function bulkResolvedById(): Map<number, ResolvedCustomChannel> {
  const resolvedById = new Map<number, ResolvedCustomChannel>()
  for (const resolved of resolvedChannels) resolvedById.set(resolved.id, resolved)
  return resolvedById
}

function textIncludes(haystack: string, needle: string, matchCase: boolean): boolean {
  if (!needle) return false
  return matchCase ? haystack.includes(needle) : haystack.toLowerCase().includes(needle.toLowerCase())
}

function replaceAllText(haystack: string, needle: string, replacement: string, matchCase: boolean): string {
  if (matchCase) return haystack.split(needle).join(replacement)
  const lowerHaystack = haystack.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  let result = ""
  let cursor = 0
  for (;;) {
    const foundAt = lowerHaystack.indexOf(lowerNeedle, cursor)
    if (foundAt === -1) {
      result += haystack.slice(cursor)
      break
    }
    result += haystack.slice(cursor, foundAt) + replacement
    cursor = foundAt + needle.length
  }
  return result
}

function countBulkRenameMatches(findText: string, matchCase: boolean): number {
  if (!findText) return 0
  const resolvedById = bulkResolvedById()
  let count = 0
  for (const channel of doc.channels) {
    if (isHeaderChannel(channel)) continue
    if (textIncludes(effectiveChannelName(channel, resolvedById), findText, matchCase)) count++
  }
  return count
}

function applyBulkRename(
  findText: string,
  replaceText: string,
  matchCase: boolean
): { doc: CustomPlaylistDoc; count: number } {
  const resolvedById = bulkResolvedById()
  let nextDoc = doc
  let count = 0
  for (const channel of doc.channels) {
    if (isHeaderChannel(channel)) continue
    const currentName = effectiveChannelName(channel, resolvedById)
    if (!textIncludes(currentName, findText, matchCase)) continue
    const nextName = replaceAllText(currentName, findText, replaceText, matchCase)
    nextDoc = setOverrides(nextDoc, channel.key, { name: nextName || null })
    count++
  }
  return { doc: nextDoc, count }
}

let bulkRenameSubmitBtn: HTMLButtonElement | null = null

function updateBulkRenamePreview(): void {
  if (!bulkRenameFindInput) return
  const findText = bulkRenameFindInput.value
  const replaceText = bulkRenameReplaceInput?.value || ""
  const matchCase = !!bulkRenameMatchCaseInput?.checked
  const count = countBulkRenameMatches(findText, matchCase)
  if (bulkRenamePreviewEl) {
    bulkRenamePreviewEl.textContent = findText ? tCount("editor.bulkRenameMatchCount", count) : ""
  }
  if (bulkRenamePreviewSampleEl) {
    const resolvedById = bulkResolvedById()
    const firstMatch = findText
      ? doc.channels.find(
          (channel) =>
            !isHeaderChannel(channel) && textIncludes(effectiveChannelName(channel, resolvedById), findText, matchCase)
        )
      : undefined
    bulkRenamePreviewSampleEl.replaceChildren()
    if (firstMatch) {
      const beforeName = effectiveChannelName(firstMatch, resolvedById)
      const afterName = replaceAllText(beforeName, findText, replaceText, matchCase)
      const beforeLine = document.createElement("div")
      beforeLine.textContent = beforeName || t("common.untitled")
      const afterLine = document.createElement("div")
      afterLine.textContent = t("editor.bulkRenamePreviewBecomes", { name: afterName || t("common.untitled") })
      bulkRenamePreviewSampleEl.append(beforeLine, afterLine)
      bulkRenamePreviewSampleEl.classList.remove("hidden")
      bulkRenamePreviewSampleEl.classList.add("flex")
    } else {
      bulkRenamePreviewSampleEl.classList.add("hidden")
      bulkRenamePreviewSampleEl.classList.remove("flex")
    }
  }
  if (bulkRenameSubmitBtn) bulkRenameSubmitBtn.disabled = !findText || count === 0
}

function openBulkRenameDialog(): void {
  if (!bulkRenameDialog || !bulkRenameFindInput || !bulkRenameReplaceInput) return
  bulkRenameDialog.querySelector("form")?.reset()
  updateBulkRenamePreview()
  bulkRenameDialog.showModal()
}

function wireBulkRenameDialog(): void {
  if (!bulkRenameDialog || !bulkRenameFindInput || !bulkRenameReplaceInput) return
  bulkRenameSubmitBtn = bulkRenameDialog.querySelector<HTMLButtonElement>('[data-role="submit"]')
  attachDialogSpatialNav(bulkRenameDialog, { defaultElement: "#editor-bulk-rename-find" })

  bulkRenameFindInput.addEventListener("input", updateBulkRenamePreview)
  bulkRenameReplaceInput.addEventListener("input", updateBulkRenamePreview)
  bulkRenameMatchCaseInput?.addEventListener("change", updateBulkRenamePreview)
  bulkRenameDialog.querySelector('[data-role="cancel"]')?.addEventListener("click", () => bulkRenameDialog.close())
  bulkRenameDialog.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault()
    const findText = bulkRenameFindInput.value
    const replaceText = bulkRenameReplaceInput.value
    const matchCase = !!bulkRenameMatchCaseInput?.checked
    if (!findText) return
    const result = applyBulkRename(findText, replaceText, matchCase)
    if (!result.count) return
    bulkRenameDialog.close()
    applyDoc(result.doc)
    toastSuccess(t("editor.toastBulkRenamed", { count: result.count }))
  })
}

// ---------------------------------------------------------------------------
// Check links
// ---------------------------------------------------------------------------
function updateCheckLinksChip(): void {
  if (!checkLinksChipEl) return
  checkLinksChipEl.classList.toggle("hidden", !checkLinksRunning)
  checkLinksChipEl.classList.toggle("flex", checkLinksRunning)
  if (checkLinksChipLabelEl) {
    checkLinksChipLabelEl.textContent = checkLinksRunning ? t("editor.checkLinksProgress", checkLinksProgress) : ""
  }
}

async function runCheckLinks(): Promise<void> {
  if (checkLinksRunning) return
  const resolvedById = bulkResolvedById()
  const targets: Array<{ key: string; url: string }> = []
  linkCheckStatus.clear()
  for (const channel of doc.channels) {
    const resolved = resolvedById.get(channel.id)
    if (!resolved || resolved.unresolved || !resolved.url) continue
    targets.push({ key: channel.key, url: resolved.url })
    linkCheckStatus.set(channel.key, "pending")
  }

  checkLinksRunning = true
  checkLinksAbort = new AbortController()
  checkLinksProgress = { done: 0, total: targets.length }
  updateCheckLinksChip()
  renderGroups()

  let okCount = 0
  let failCount = 0
  let uncheckedCount = 0
  let rerenderScheduled = false
  const scheduleRerender = (): void => {
    if (rerenderScheduled) return
    rerenderScheduled = true
    requestAnimationFrame(() => {
      rerenderScheduled = false
      renderGroups()
    })
  }

  const signal = checkLinksAbort.signal
  const queue = [...targets]
  const worker = async (): Promise<void> => {
    while (queue.length && !signal.aborted) {
      const target = queue.shift()
      if (!target) break
      const result = await probeStreamHead(target.url, signal)
      if (result.aborted) {
        linkCheckStatus.delete(target.key)
        break
      }
      // A browser CORS/mixed-content block reports as "couldn't check", not "failed".
      const status: LinkCheckStatus = result.ok ? "ok" : result.blocked ? "unchecked" : "fail"
      linkCheckStatus.set(target.key, status)
      if (status === "ok") okCount++
      else if (status === "fail") failCount++
      else uncheckedCount++
      checkLinksProgress = { done: checkLinksProgress.done + 1, total: checkLinksProgress.total }
      updateCheckLinksChip()
      scheduleRerender()
    }
  }
  const concurrency = Math.min(4, targets.length)
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  // Any target never reached (queue drained by abort) reverts from "pending" to no dot.
  if (signal.aborted) {
    for (const target of queue) linkCheckStatus.delete(target.key)
  }

  const wasCancelled = signal.aborted
  checkLinksRunning = false
  checkLinksAbort = null
  updateCheckLinksChip()
  renderGroups()
  if (wasCancelled) {
    toastWarn(t("editor.toastCheckLinksCancelled", { ok: okCount, failed: failCount }))
  } else {
    let message = t("editor.toastCheckLinksDone", { ok: okCount, failed: failCount })
    if (uncheckedCount > 0) message += t("editor.toastCheckLinksUncheckedSuffix", { unchecked: uncheckedCount })
    toastSuccess(message)
  }
}

function cancelCheckLinks(): void {
  checkLinksAbort?.abort()
}

function toggleCheckLinks(): void {
  if (checkLinksRunning) cancelCheckLinks()
  else void runCheckLinks()
}

// ---------------------------------------------------------------------------
// Toolbar "More" menu: folds the secondary toolbar actions into one button.
// ---------------------------------------------------------------------------
function openToolbarMoreMenu(anchor: HTMLButtonElement): void {
  const items: MenuItemDef[] = [
    { key: "bulk-rename", label: t("editor.bulkRenameBtn"), onClick: () => openBulkRenameDialog() },
    {
      key: "check-links",
      label: checkLinksRunning ? t("common.cancel") : t("editor.checkLinksBtn"),
      onClick: toggleCheckLinks,
    },
    { key: "export", label: t("editor.export"), onClick: () => void exportPlaylist() },
  ]
  if (anyUnresolvedChannels()) {
    items.push({
      key: "remove-unavailable",
      label: t("editor.removeUnavailable"),
      destructive: true,
      onClick: () => removeUnavailableChannels(),
    })
  }
  openMenu(anchor, items, t("livetv.moreActions"))
}

// ---------------------------------------------------------------------------
// Keyboard accelerators
// ---------------------------------------------------------------------------
function wireKeyboardShortcuts(): void {
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase()
    const isUndoCombo = (event.ctrlKey || event.metaKey) && !event.shiftKey && key === "z"
    const isRedoCombo =
      ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "z") ||
      ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === "y")
    if (isUndoCombo || isRedoCombo) {
      if (document.querySelector("dialog[open]")) return
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName
      if (tagName === "INPUT" || tagName === "TEXTAREA" || target?.isContentEditable) {
        if (!isSettledTrackedInput(target as HTMLInputElement)) return
      } else if (tagName === "SELECT") {
        return
      }
      event.preventDefault()
      if (isUndoCombo) undo()
      else redo()
      return
    }

    const target = event.target as HTMLElement | null
    const row = target?.closest<HTMLElement>(".editor-channel-row[data-key]")
    if (!row?.dataset.key) return
    const rowKey = row.dataset.key
    const rowInSelection = selectedChannelKeys.size > 0 && selectedChannelKeys.has(rowKey)
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault()
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (rowInSelection) applyDoc(moveChannelsWithinGroup(doc, [...selectedChannelKeys], direction))
      else applyDoc(moveChannelWithinGroup(doc, rowKey, direction))
      return
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (target?.tagName === "INPUT" || target?.isContentEditable) return
      event.preventDefault()
      if (rowInSelection) {
        void removeSelectedChannelsWithUndo()
        return
      }
      const channel = doc.channels.find((item) => item.key === rowKey)
      if (!channel) return
      const resolved = findResolved(channel)
      const displayName = channel.overrides.name ?? resolved?.name ?? ""
      removeChannelWithUndo(channel, displayName)
    }
  })
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function showNotFound(title: string, body: string): void {
  const section = byId("editor-not-found")
  const titleEl = section?.querySelector<HTMLElement>("h1")
  const bodyEl = section?.querySelector<HTMLElement>("p")
  if (titleEl) titleEl.textContent = title
  if (bodyEl) bodyEl.textContent = body
  section?.classList.remove("hidden")
  section?.classList.add("flex")
}

async function init(): Promise<void> {
  // Toasts anchored top-center would sit over the toolbar on this page.
  document.documentElement.setAttribute("data-toast-position", "bottom")

  entryId = new URLSearchParams(location.search).get("id") || ""
  let entries: any[]
  try {
    entries = await getEntries()
  } catch (err) {
    log.warn("[xt:editor] getEntries failed:", err)
    showNotFound(t("editor.loadErrorTitle"), t("editor.loadErrorBody"))
    return
  }
  customEntry = entries.find((entry: any) => entry._id === entryId && entry.type === "custom") || null

  if (!customEntry) {
    showNotFound(t("editor.notFoundTitle"), t("editor.notFoundBody"))
    return
  }

  sourceTitleById = new Map(entries.map((entry: any) => [entry._id, entry.title || entry._id]))
  loadActivePane()
  loadCollapsedGroups()
  loadSourceSortMode()

  try {
    doc = await loadCustomDoc(entryId)
  } catch (err) {
    log.warn("[xt:editor] loadCustomDoc failed:", err)
    toastError(t("editor.toastLoadFailed"))
    showNotFound(t("editor.loadErrorTitle"), t("editor.loadErrorBody"))
    return
  }
  presentSourceKeySet = presentSourceKeys(doc)
  presentSourceKeysByGroupMap = presentSourceKeysByGroup(doc)

  byId("editor-main")?.classList.remove("hidden")
  byId("editor-main")?.classList.add("flex")

  invalidateEntry(entryId)
  if (titleInput) {
    titleInput.value = customEntry.title || ""
    markInputCommitted(titleInput)
  }
  renderChannelCount()

  populateSourceSelect(entries)
  mountSourceEmpty(t("editor.selectSourcePrompt"))

  await refreshResolvedChannels()
  renderGroups()

  titleInput?.addEventListener("input", scheduleTitleSave)
  sourceSelect?.addEventListener("change", () => void onSourceChange())
  sourceSearchInput?.addEventListener("input", debounce(() => applySourceFilter(), 150))
  sourceCategorySelect?.addEventListener("change", () => applySourceFilter())
  sourceSortSelect?.addEventListener("change", () => {
    saveSourceSortMode(sourceSortSelect.value)
    applySourceFilter()
  })
  sourceSelectAllBtn?.addEventListener("click", () => selectAllFilteredSourceChannels())
  sourceDeselectAllBtn?.addEventListener("click", () => deselectAllFilteredSourceChannels())
  sourceListEl?.addEventListener("scroll", scheduleSourceRender)
  addSelectedBtn?.addEventListener("click", () => void addSelectedChannels())
  undoBtn?.addEventListener("click", () => undo())
  redoBtn?.addEventListener("click", () => redo())
  toolbarMoreBtn?.addEventListener("click", () => openToolbarMoreMenu(toolbarMoreBtn))
  checkLinksChipCancelBtn?.addEventListener("click", () => cancelCheckLinks())
  saveRetryBtn?.addEventListener("click", () => void flushSave())
  emptyAddUrlBtn?.addEventListener("click", () => addUrlBtn?.click())
  emptySourceBtn?.addEventListener("click", () => setActivePane("source"))
  groupsContainer?.addEventListener("scroll", closeMenu)
  bulkMoveUpBtn?.addEventListener("click", () => applyDoc(moveChannelsWithinGroup(doc, [...selectedChannelKeys], "up")))
  bulkMoveDownBtn?.addEventListener("click", () => applyDoc(moveChannelsWithinGroup(doc, [...selectedChannelKeys], "down")))
  bulkMoveToGroupBtn?.addEventListener("click", () => openBulkMoveToGroupMenu(bulkMoveToGroupBtn))
  bulkMoreBtn?.addEventListener("click", () => openBulkMoreMenu(bulkMoreBtn))
  bulkRemoveBtn?.addEventListener("click", () => void removeSelectedChannelsWithUndo())
  bulkClearBtn?.addEventListener("click", () => clearSelection())

  wirePaneSwitcher()
  wireKeyboardShortcuts()
  wireSelectionEscape()
  wireFavoritesSync()
  wireNewGroupDialog()
  wireAddUrlDialog()
  wireBulkRenameDialog()
  updateUndoButton()
}

void init()

function flushOnTeardown(): void {
  if (!customEntry) return
  try {
    saveTitleNow()
    void flushSave()
  } catch (err) {
    log.warn("[xt:editor] teardown flush failed:", err)
  }
}

window.addEventListener("pagehide", flushOnTeardown)
// Fires earlier than pagehide on mobile WebView; flush is still best-effort.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushOnTeardown()
})
