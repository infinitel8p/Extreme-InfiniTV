// Playlist editor bundle for /playlist-editor; every mutation goes through `applyDoc()`.

import { invalidateEntry } from "@/scripts/lib/cache.js"
import {
  loadCustomDoc,
  saveCustomDoc,
  addChannel,
  removeChannels,
  moveChannel,
  setOverrides,
  setCatchup,
  renameGroup,
  reorderGroups,
  resolveCustomChannels,
  type CustomPlaylistDoc,
  type CustomChannel,
  type CustomChannelOverrides,
  type CustomChannelCatchup,
  type CustomSource,
  type ResolvedCustomChannel,
} from "@/scripts/lib/custom-playlist.ts"
import { getEntries, entryToCreds, updateEntry } from "@/scripts/lib/creds.js"
import { ensureLive, buildCustomSourcePools } from "@/scripts/lib/catalog.js"
import { serializeM3U } from "@/scripts/lib/m3u-serializer.ts"
import { buildM3UEntriesForEntry, saveM3UText, sanitizeFilename } from "@/scripts/lib/export-m3u.ts"
import { probeStreamHead } from "@/scripts/lib/stream-diagnostic.js"
import { normalize } from "@/scripts/lib/text.ts"
import { debounce } from "@/scripts/lib/debounce.ts"
import { t } from "@/scripts/lib/i18n.ts"
import { toastSuccess, toastError, toastWarn } from "@/scripts/lib/toast.ts"
import { confirmDialog } from "@/scripts/lib/confirm-dialog.ts"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.ts"
import { ICON_GRIP_VERTICAL, ICON_ARROW_UP, ICON_ARROW_DOWN, ICON_TRASH, ICON_PENCIL } from "@/scripts/lib/icons.ts"
import { log } from "@/scripts/lib/log.ts"
import { mountCachedImage } from "@/scripts/lib/img-cache.ts"
import { getDensityFactor } from "@/scripts/lib/app-settings.js"

const ROW_H = Math.max(44, Math.round(56 * getDensityFactor()))
const SOURCE_OVERSCAN = 6

let entryId = ""
let customEntry: any = null
let doc: CustomPlaylistDoc = { version: 1, nextId: 1, groups: [], channels: [] }

let allSourceChannels: any[] = []
let filteredSourceChannels: any[] = []
let selectedSourceEntryId = ""
const selectedIds = new Set<number>()
let lastClickedIndex = -1

let orderedChannels: CustomChannel[] = []
let resolvedChannels: ResolvedCustomChannel[] = []

let editingChannelKey: string | null = null

const MAX_UNDO_DEPTH = 20
const undoStack: CustomPlaylistDoc[] = []

type LinkCheckStatus = "pending" | "ok" | "fail"
const linkCheckStatus = new Map<string, LinkCheckStatus>()
let checkLinksRunning = false
let checkLinksAbort: AbortController | null = null
let checkLinksProgress = { done: 0, total: 0 }

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const byId = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null

const titleInput = byId<HTMLInputElement>("editor-title-input")
const channelCountEl = byId<HTMLElement>("editor-channel-count")
const sourceSelect = byId<HTMLSelectElement>("editor-source-select")
const sourceSearchInput = byId<HTMLInputElement>("editor-source-search")
const sourceCategorySelect = byId<HTMLSelectElement>("editor-source-category")
const sourceListEl = byId<HTMLElement>("editor-source-list")
const sourceSpacer = byId<HTMLElement>("editor-source-spacer")
const sourceViewport = byId<HTMLElement>("editor-source-viewport")
const sourceEmptyEl = byId<HTMLElement>("editor-source-empty")
const sourceSelectedCountEl = byId<HTMLElement>("editor-source-selected-count")
const sourceTargetGroupInput = byId<HTMLInputElement>("editor-source-target-group")
const addSelectedBtn = byId<HTMLButtonElement>("editor-add-selected-btn")

const groupsContainer = byId<HTMLElement>("editor-groups")
const emptyStateEl = byId<HTMLElement>("editor-empty-state")

const undoBtn = byId<HTMLButtonElement>("editor-undo-btn")

const newGroupBtn = byId<HTMLButtonElement>("editor-new-group-btn")
const newGroupDialog = byId<HTMLDialogElement>("editor-new-group-dialog")
const newGroupNameInput = byId<HTMLInputElement>("editor-new-group-name")

const bulkRenameBtn = byId<HTMLButtonElement>("editor-bulk-rename-btn")
const bulkRenameDialog = byId<HTMLDialogElement>("editor-bulk-rename-dialog")
const bulkRenameFindInput = byId<HTMLInputElement>("editor-bulk-rename-find")
const bulkRenameReplaceInput = byId<HTMLInputElement>("editor-bulk-rename-replace")
const bulkRenamePreviewEl = byId<HTMLElement>("editor-bulk-rename-preview")

const checkLinksBtn = byId<HTMLButtonElement>("editor-check-links-btn")
const checkLinksLabelEl = byId<HTMLElement>("editor-check-links-label")

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

const editDialog = byId<HTMLDialogElement>("editor-channel-edit-dialog")
const editNameInput = byId<HTMLInputElement>("editor-edit-name")
const editLogoInput = byId<HTMLInputElement>("editor-edit-logo")
const editChnoInput = byId<HTMLInputElement>("editor-edit-chno")
const editTvgIdInput = byId<HTMLInputElement>("editor-edit-tvgid")
const editCatchupModeSelect = byId<HTMLSelectElement>("editor-edit-catchup-mode")
const editCatchupDaysInput = byId<HTMLInputElement>("editor-edit-catchup-days")
const editCatchupSourceInput = byId<HTMLInputElement>("editor-edit-catchup-source")

const exportBtn = byId<HTMLButtonElement>("editor-export-btn")

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

function reorderWithinGroup(source: CustomPlaylistDoc, key: string, direction: "up" | "down"): CustomPlaylistDoc {
  const channel = source.channels.find((item) => item.key === key)
  if (!channel) return source
  const groupChannels = source.channels.filter((item) => item.group === channel.group)
  const idx = groupChannels.findIndex((item) => item.key === key)
  if (idx === -1) return source
  if (direction === "up") {
    if (idx <= 0) return source
    return moveChannel(source, key, groupChannels[idx - 1].key, channel.group)
  }
  if (idx >= groupChannels.length - 1) return source
  const afterNextIdx = idx + 2
  const beforeKey = afterNextIdx < groupChannels.length ? groupChannels[afterNextIdx].key : null
  return moveChannel(source, key, beforeKey, channel.group)
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
async function flushSave(): Promise<void> {
  try {
    const saved = await saveCustomDoc(entryId, doc)
    if (!saved) {
      toastError(t("editor.toastSaveFailed"))
      return
    }
    invalidateEntry(entryId)
    document.dispatchEvent(new CustomEvent("xt:entries-updated"))
  } catch (err) {
    log.warn("[xt:editor] save failed:", err)
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
  renderChannelCount()
  renderGroups()
  updateUndoButton()
  scheduleSave()
  scheduleResolvedRefresh()
}

// Single chokepoint for every doc mutation: snapshots for undo, persists (debounced), re-renders.
function applyDoc(nextDoc: CustomPlaylistDoc): void {
  if (nextDoc === doc) return
  undoStack.push(doc)
  if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift()
  commitDoc(nextDoc)
}

function undo(): void {
  const previousDoc = undoStack.pop()
  if (!previousDoc) return
  commitDoc(previousDoc)
}

function updateUndoButton(): void {
  if (undoBtn) undoBtn.disabled = undoStack.length === 0
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function renderChannelCount(): void {
  if (channelCountEl) channelCountEl.textContent = t("editor.channelCount", { count: doc.channels.length })
}

function saveTitleNow(): void {
  if (!titleInput || !customEntry) return
  const value = titleInput.value.trim()
  if (!value) return
  customEntry.title = value
  updateEntry(entryId, { title: value }).catch((err) => {
    log.warn("[xt:editor] title save failed:", err)
    toastError(t("editor.toastSaveFailed"))
  })
}

const scheduleTitleSave = debounce(saveTitleNow, 400)

// ---------------------------------------------------------------------------
// Source browser (left pane)
// ---------------------------------------------------------------------------
function populateSourceSelect(entries: any[]): void {
  if (!sourceSelect) return
  const candidates = entries.filter((entry) => entry._id !== entryId && entry.type !== "custom")
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

function populateCategoryFilter(): void {
  if (!sourceCategorySelect) return
  const categories = new Set<string>()
  for (const channel of allSourceChannels) {
    if (channel.category) categories.add(channel.category)
  }
  const sorted = [...categories].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  sourceCategorySelect.replaceChildren()
  const allOpt = document.createElement("option")
  allOpt.value = ""
  allOpt.textContent = t("list.allCategories")
  sourceCategorySelect.appendChild(allOpt)
  for (const category of sorted) {
    const opt = document.createElement("option")
    opt.value = category
    opt.textContent = category
    sourceCategorySelect.appendChild(opt)
  }
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
  try {
    const channels = await ensureLive(entryToCreds(sourceEntry), sourceEntry._id)
    if (selectedSourceEntryId !== requestedSourceEntryId) return
    allSourceChannels = channels || []
  } catch (err) {
    log.warn("[xt:editor] source load failed:", err)
    if (selectedSourceEntryId !== requestedSourceEntryId) return
    allSourceChannels = []
  }
  populateCategoryFilter()
  applySourceFilter()
}

function applySourceFilter(): void {
  lastClickedIndex = -1
  const tokens = normalize(sourceSearchInput?.value || "").split(" ").filter(Boolean)
  const category = sourceCategorySelect?.value || ""
  filteredSourceChannels = allSourceChannels.filter((channel) => {
    if (category && channel.category !== category) return false
    if (!tokens.length) return true
    const norm = channel.norm || normalize(`${channel.name || ""} ${channel.category || ""}`)
    return tokens.every((token) => norm.includes(token))
  })
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

function buildSourceRow(channel: any, idx: number): HTMLElement {
  const row = document.createElement("div")
  row.className =
    "flex w-full items-center gap-2.5 px-2.5 cursor-pointer hover:bg-surface-2 focus-visible:bg-surface-2 outline-none"
  row.style.height = `${ROW_H}px`
  row.dataset.idx = String(idx)
  row.tabIndex = 0
  const checked = selectedIds.has(channel.id)
  if (checked) row.classList.add("bg-accent-soft")

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

function buildSourceForChannel(sourceEntry: any, channel: any): CustomSource | null {
  if (sourceEntry.type === "xtream") {
    return { kind: "xtream", entryId: sourceEntry._id, streamId: channel.id }
  }
  if (sourceEntry.type === "m3u" || sourceEntry.type === "local-m3u") {
    if (!channel.url) return null
    return { kind: "m3u", entryId: sourceEntry._id, url: channel.url, name: channel.name || "" }
  }
  return null
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
  let nextDoc = doc
  let addedCount = 0
  for (const channel of channelsSnapshot) {
    if (!selectedIds.has(channel.id)) continue
    const source = buildSourceForChannel(sourceEntry, channel)
    if (!source) continue
    const result = addChannel(nextDoc, source, {
      name: channel.name || "",
      logo: channel.logo || null,
      group: overrideGroup || channel.category || null,
      tvgId: channel.tvgId || null,
      chno: channel.chno ?? null,
    })
    nextDoc = result.doc
    addedCount++
  }
  if (!addedCount) return
  selectedIds.clear()
  lastClickedIndex = -1
  updateSelectedCount()
  renderSourceList()
  applyDoc(nextDoc)
  toastSuccess(t("editor.toastAdded", { count: addedCount }))
}

// ---------------------------------------------------------------------------
// Playlist pane (right)
// ---------------------------------------------------------------------------
function iconButton(svg: string, label: string): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "btn h-9 w-9 p-0 shrink-0"
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

function renderGroups(): void {
  refreshGroupsDatalist()
  if (!groupsContainer || !emptyStateEl) return
  groupsContainer.replaceChildren()
  if (!doc.channels.length) {
    emptyStateEl.classList.remove("hidden")
    return
  }
  emptyStateEl.classList.add("hidden")

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

  const header = document.createElement("div")
  header.className = "editor-group-header flex items-center gap-2"

  const nameInput = document.createElement("input")
  nameInput.type = "text"
  nameInput.value = groupName
  nameInput.className = "field-input h-9 flex-1 min-w-0 font-semibold text-sm"
  nameInput.addEventListener("change", () => {
    const nextName = nameInput.value.trim()
    if (!nextName || nextName === groupName) {
      nameInput.value = groupName
      return
    }
    applyDoc(renameGroup(doc, groupName, nextName))
  })

  const count = document.createElement("span")
  count.className = "text-2xs text-fg-3 tabular-nums shrink-0"
  count.textContent = String(rows.length)

  const upBtn = iconButton(ICON_ARROW_UP, t("editor.moveGroupUp"))
  upBtn.disabled = groupIdx === 0
  upBtn.addEventListener("click", () => applyDoc(reorderGroupPosition(doc, groupName, "up")))

  const downBtn = iconButton(ICON_ARROW_DOWN, t("editor.moveGroupDown"))
  downBtn.disabled = groupIdx === groupCount - 1
  downBtn.addEventListener("click", () => applyDoc(reorderGroupPosition(doc, groupName, "down")))

  header.append(nameInput, count, upBtn, downBtn)
  addGroupDropHandlers(header, groupName)
  section.appendChild(header)

  const list = document.createElement("div")
  list.className = "editor-group flex flex-col gap-1 rounded-lg"
  list.dataset.group = groupName
  rows.forEach((row, rowIdx) => {
    list.appendChild(buildChannelRow(row.channel, row.resolved, rows.length, rowIdx))
  })
  addGroupDropHandlers(list, groupName)
  section.appendChild(list)

  return section
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
    const draggedKey = event.dataTransfer?.getData("text/plain")
    if (!draggedKey) return
    applyDoc(moveChannel(doc, draggedKey, null, groupName))
  })
}

function buildChannelRow(
  channel: CustomChannel,
  resolved: ResolvedCustomChannel | undefined,
  groupSize: number,
  rowIdx: number
): HTMLElement {
  const row = document.createElement("div")
  row.className =
    "editor-channel-row flex items-center gap-2 rounded-lg border border-line bg-bg px-2 py-1.5"
  row.draggable = true
  row.dataset.key = channel.key

  const grip = document.createElement("span")
  grip.className = "text-fg-3 shrink-0 inline-flex cursor-grab"
  grip.innerHTML = ICON_GRIP_VERTICAL
  grip.setAttribute("aria-hidden", "true")
  grip.title = t("editor.dragHandleLabel")

  // Shape differs per status so it never reads by hue alone.
  const statusDot = document.createElement("span")
  statusDot.className = "size-2 shrink-0 bg-transparent"
  const status = linkCheckStatus.get(channel.key)
  if (status === "pending") {
    statusDot.classList.add("rounded-full", "border", "border-fg-3", "animate-pulse")
  } else if (status === "ok") {
    statusDot.classList.add("rounded-full", "bg-ok")
  } else if (status === "fail") {
    statusDot.classList.add("rotate-45", "rounded-xs", "bg-bad")
  }
  if (status) {
    const statusLabel = t(
      status === "pending"
        ? "editor.linkStatusChecking"
        : status === "ok"
          ? "editor.linkStatusOk"
          : "editor.linkStatusFail"
    )
    statusDot.setAttribute("role", "img")
    statusDot.setAttribute("aria-label", statusLabel)
    statusDot.title = statusLabel
  } else {
    statusDot.setAttribute("aria-hidden", "true")
  }

  const logo = document.createElement("div")
  logo.className =
    "h-8 w-8 shrink-0 rounded overflow-hidden ring-1 ring-inset ring-line bg-surface-2 flex items-center justify-center"
  const logoUrl = resolved?.logo || channel.overrides.logo
  if (logoUrl) {
    const img = document.createElement("img")
    img.alt = ""
    img.loading = "lazy"
    img.referrerPolicy = "no-referrer"
    img.className = "h-full w-full object-contain"
    img.onerror = () => img.remove()
    logo.appendChild(img)
    mountCachedImage(img, logoUrl, "logo")
  }

  const nameWrap = document.createElement("div")
  nameWrap.className = "flex items-center gap-1.5 flex-1 min-w-0"

  const nameInput = document.createElement("input")
  nameInput.type = "text"
  nameInput.value = channel.overrides.name ?? resolved?.name ?? ""
  nameInput.placeholder = resolved?.name || ""
  nameInput.className = "field-input h-9 flex-1 min-w-0 text-sm"
  nameInput.addEventListener("change", () => {
    const value = nameInput.value.trim()
    applyDoc(setOverrides(doc, channel.key, { name: value || null }))
  })
  nameWrap.appendChild(nameInput)

  if (resolved?.unresolved) {
    const badge = document.createElement("span")
    badge.className = "shrink-0 rounded-md border border-line bg-surface-2 px-1.5 text-2xs text-fg-3"
    badge.textContent = t("editor.unresolvedBadge")
    nameWrap.appendChild(badge)
  }

  const moveSelect = document.createElement("select")
  moveSelect.className = "field-input h-9 w-32 shrink-0 text-xs"
  moveSelect.setAttribute("aria-label", t("editor.moveToGroupLabel"))
  for (const groupOption of doc.groups) {
    const opt = document.createElement("option")
    opt.value = groupOption
    opt.textContent = groupOption
    if (groupOption === channel.group) opt.selected = true
    moveSelect.appendChild(opt)
  }
  moveSelect.addEventListener("change", () => {
    const target = moveSelect.value
    if (target === channel.group) return
    applyDoc(moveChannel(doc, channel.key, null, target))
  })

  const upBtn = iconButton(ICON_ARROW_UP, t("editor.moveUp"))
  upBtn.disabled = rowIdx === 0
  upBtn.addEventListener("click", () => applyDoc(reorderWithinGroup(doc, channel.key, "up")))

  const downBtn = iconButton(ICON_ARROW_DOWN, t("editor.moveDown"))
  downBtn.disabled = rowIdx === groupSize - 1
  downBtn.addEventListener("click", () => applyDoc(reorderWithinGroup(doc, channel.key, "down")))

  const editBtn = iconButton(ICON_PENCIL, t("editor.editDetails"))
  editBtn.addEventListener("click", () => openEditDialog(channel))

  const removeBtn = iconButton(ICON_TRASH, t("editor.removeChannel"))
  removeBtn.classList.add("hover:text-bad", "hover:border-bad/40")
  removeBtn.addEventListener("click", async () => {
    const displayName = channel.overrides.name || resolved?.name || ""
    const ok = await confirmDialog({
      title: t("editor.removeChannel"),
      message: t("editor.removeChannelConfirm", { name: displayName }),
      confirmLabel: t("common.delete"),
      destructive: true,
    })
    if (!ok) return
    applyDoc(removeChannels(doc, [channel.key]))
  })

  row.append(grip, statusDot, logo, nameWrap, moveSelect, upBtn, downBtn, editBtn, removeBtn)

  row.addEventListener("dragstart", (event) => {
    row.dataset.dragging = "true"
    event.dataTransfer?.setData("text/plain", channel.key)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
  })
  row.addEventListener("dragend", () => {
    row.dataset.dragging = "false"
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
    const draggedKey = event.dataTransfer?.getData("text/plain")
    if (!draggedKey || draggedKey === channel.key) return
    applyDoc(moveChannel(doc, draggedKey, channel.key, channel.group))
  })

  return row
}

function openEditDialog(channel: CustomChannel): void {
  if (!editDialog || !editNameInput || !editLogoInput || !editChnoInput || !editTvgIdInput) return
  editingChannelKey = channel.key
  editNameInput.value = channel.overrides.name ?? ""
  editLogoInput.value = channel.overrides.logo ?? ""
  editChnoInput.value = channel.overrides.chno != null ? String(channel.overrides.chno) : ""
  editTvgIdInput.value = channel.overrides.tvgId ?? ""
  if (editCatchupModeSelect) editCatchupModeSelect.value = channel.catchup?.catchup ?? ""
  if (editCatchupDaysInput) {
    editCatchupDaysInput.value = channel.catchup?.catchupDays != null ? String(channel.catchup.catchupDays) : ""
  }
  if (editCatchupSourceInput) editCatchupSourceInput.value = channel.catchup?.catchupSource ?? ""
  editDialog.showModal()
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
async function exportPlaylist(): Promise<void> {
  if (!customEntry || !exportBtn) return
  exportBtn.disabled = true
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
    if (skippedCount > 0) toastError(t("editor.toastExportSkipped", { count: skippedCount }))
  } catch (err) {
    log.warn("[xt:editor] export failed:", err)
    toastError(t("editor.toastExportFail"), { description: (err as any)?.message })
  } finally {
    exportBtn.disabled = false
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
    const result = addChannel(doc, source, { name, logo, group })
    applyDoc(result.doc)
    addUrlDialog.close()
    toastSuccess(t("editor.toastUrlAdded"))
  })
}

function wireEditDialog(): void {
  if (!editDialog) return
  attachDialogSpatialNav(editDialog, { defaultElement: "#editor-edit-name" })
  editDialog.querySelector('[data-role="cancel"]')?.addEventListener("click", () => editDialog.close())
  editDialog.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault()
    editDialog.close()
    if (!editingChannelKey) return
    const patch: Partial<CustomChannelOverrides> = {
      name: editNameInput?.value.trim() || null,
      logo: editLogoInput?.value.trim() || null,
      chno: editChnoInput?.value.trim() ? Math.max(0, Number(editChnoInput.value)) : null,
      tvgId: editTvgIdInput?.value.trim() || null,
    }
    const catchupMode = editCatchupModeSelect?.value || ""
    const catchup: CustomChannelCatchup | null = catchupMode
      ? {
          catchup: catchupMode,
          catchupDays: editCatchupDaysInput?.value.trim() ? Math.max(0, Number(editCatchupDaysInput.value)) : null,
          catchupSource: editCatchupSourceInput?.value.trim() || null,
          catchupCorrection: null,
        }
      : null
    const nextDoc = setCatchup(setOverrides(doc, editingChannelKey, patch), editingChannelKey, catchup)
    applyDoc(nextDoc)
    editingChannelKey = null
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

function countBulkRenameMatches(findText: string): number {
  if (!findText) return 0
  const resolvedById = bulkResolvedById()
  let count = 0
  for (const channel of doc.channels) {
    if (effectiveChannelName(channel, resolvedById).includes(findText)) count++
  }
  return count
}

function applyBulkRename(findText: string, replaceText: string): { doc: CustomPlaylistDoc; count: number } {
  const resolvedById = bulkResolvedById()
  let nextDoc = doc
  let count = 0
  for (const channel of doc.channels) {
    const currentName = effectiveChannelName(channel, resolvedById)
    if (!currentName.includes(findText)) continue
    const nextName = currentName.split(findText).join(replaceText)
    nextDoc = setOverrides(nextDoc, channel.key, { name: nextName || null })
    count++
  }
  return { doc: nextDoc, count }
}

function wireBulkRenameDialog(): void {
  if (!bulkRenameBtn || !bulkRenameDialog || !bulkRenameFindInput || !bulkRenameReplaceInput) return
  const submitBtn = bulkRenameDialog.querySelector<HTMLButtonElement>('[data-role="submit"]')
  attachDialogSpatialNav(bulkRenameDialog, { defaultElement: "#editor-bulk-rename-find" })

  const updatePreview = (): void => {
    const findText = bulkRenameFindInput.value
    const count = countBulkRenameMatches(findText)
    if (bulkRenamePreviewEl) {
      bulkRenamePreviewEl.textContent = findText ? t("editor.bulkRenameMatchCount", { count }) : ""
    }
    if (submitBtn) submitBtn.disabled = !findText || count === 0
  }

  bulkRenameBtn.addEventListener("click", () => {
    bulkRenameDialog.querySelector("form")?.reset()
    updatePreview()
    bulkRenameDialog.showModal()
  })
  bulkRenameFindInput.addEventListener("input", updatePreview)
  bulkRenameReplaceInput.addEventListener("input", updatePreview)
  bulkRenameDialog.querySelector('[data-role="cancel"]')?.addEventListener("click", () => bulkRenameDialog.close())
  bulkRenameDialog.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault()
    const findText = bulkRenameFindInput.value
    const replaceText = bulkRenameReplaceInput.value
    if (!findText) return
    const result = applyBulkRename(findText, replaceText)
    if (!result.count) return
    bulkRenameDialog.close()
    applyDoc(result.doc)
    toastSuccess(t("editor.toastBulkRenamed", { count: result.count }))
  })
}

// ---------------------------------------------------------------------------
// Check links
// ---------------------------------------------------------------------------
function updateCheckLinksButton(): void {
  if (!checkLinksBtn) return
  if (checkLinksLabelEl) {
    checkLinksLabelEl.textContent = checkLinksRunning
      ? t("editor.checkLinksProgress", checkLinksProgress)
      : t("editor.checkLinksBtn")
  }
  checkLinksBtn.title = checkLinksRunning ? t("common.cancel") : ""
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
  updateCheckLinksButton()
  renderGroups()

  let okCount = 0
  let failCount = 0
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
      linkCheckStatus.set(target.key, result.ok ? "ok" : "fail")
      if (result.ok) okCount++
      else failCount++
      checkLinksProgress = { done: checkLinksProgress.done + 1, total: checkLinksProgress.total }
      updateCheckLinksButton()
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
  updateCheckLinksButton()
  renderGroups()
  if (wasCancelled) {
    toastWarn(t("editor.toastCheckLinksCancelled", { ok: okCount, fail: failCount }))
  } else {
    toastSuccess(t("editor.toastCheckLinksDone", { ok: okCount, fail: failCount }))
  }
}

function cancelCheckLinks(): void {
  checkLinksAbort?.abort()
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

  try {
    doc = await loadCustomDoc(entryId)
  } catch (err) {
    log.warn("[xt:editor] loadCustomDoc failed:", err)
    toastError(t("editor.toastLoadFailed"))
    showNotFound(t("editor.loadErrorTitle"), t("editor.loadErrorBody"))
    return
  }

  byId("editor-main")?.classList.remove("hidden")
  byId("editor-main")?.classList.add("flex")

  invalidateEntry(entryId)
  if (titleInput) titleInput.value = customEntry.title || ""
  renderChannelCount()

  populateSourceSelect(entries)
  mountSourceEmpty(t("editor.selectSourcePrompt"))

  await refreshResolvedChannels()
  renderGroups()

  titleInput?.addEventListener("input", scheduleTitleSave)
  sourceSelect?.addEventListener("change", () => void onSourceChange())
  sourceSearchInput?.addEventListener("input", debounce(() => applySourceFilter(), 150))
  sourceCategorySelect?.addEventListener("change", () => applySourceFilter())
  sourceListEl?.addEventListener("scroll", scheduleSourceRender)
  addSelectedBtn?.addEventListener("click", () => void addSelectedChannels())
  exportBtn?.addEventListener("click", () => void exportPlaylist())
  undoBtn?.addEventListener("click", () => undo())
  checkLinksBtn?.addEventListener("click", () => {
    if (checkLinksRunning) cancelCheckLinks()
    else void runCheckLinks()
  })
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return
    const target = event.target as HTMLElement | null
    const tagName = target?.tagName
    if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || target?.isContentEditable) return
    if (document.querySelector("dialog[open]")) return
    event.preventDefault()
    undo()
  })

  wireNewGroupDialog()
  wireAddUrlDialog()
  wireEditDialog()
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
// visibilitychange fires earlier and more reliably than pagehide on mobile/Android WebView; best-effort since IndexedDB has no synchronous flush.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushOnTeardown()
})
