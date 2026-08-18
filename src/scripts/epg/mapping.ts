// @ts-nocheck - manual Jellyfin-style channel-to-EPG mapping dialog. Wires
// the "Map channels" affordance on /epg into preferences.channelEpgMap.
import { log } from "@/scripts/lib/log.js"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import { debounce } from "@/scripts/lib/debounce.js"
import { normalize } from "@/scripts/lib/text.js"
import {
  loadCreds,
  getActiveEntry,
  isLikelyM3USource,
  safeHttpUrl,
} from "@/scripts/lib/creds.js"
import { getCached } from "@/scripts/lib/cache.js"
import {
  effectiveTvgId,
  getAvailableEpgChannels,
  classifyTvgIdSource,
  EPG_LOADED_EVENT,
} from "@/scripts/lib/epg-data.js"
import {
  setChannelEpgOverride,
  clearChannelEpgOverride,
  getChannelEpgOverride,
  CHANNEL_EPG_CHANGED_EVENT,
} from "@/scripts/lib/preferences.js"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { ICON_INFO } from "@/scripts/lib/icons.js"
import { getDensityFactor } from "@/scripts/lib/app-settings.js"

type Channel = {
  id: number
  name: string
  tvgId?: string
  logo?: string | null
  category?: string
}

const openBtn = document.getElementById("epg-map-open")
const mapDialog = document.getElementById("epg-map-dialog") as HTMLDialogElement | null
const mapCloseBtn = document.getElementById("epg-map-close")
const mapListEl = document.getElementById("epg-map-list")
const mapStatusEl = document.getElementById("epg-map-status")
const mapSearchEl = document.getElementById("epg-map-search") as HTMLInputElement | null
const mapFilterEl = document.getElementById("epg-map-filter")

const pickDialog = document.getElementById("epg-pick-dialog") as HTMLDialogElement | null
const pickCloseBtn = document.getElementById("epg-pick-close")
const pickListEl = document.getElementById("epg-pick-list")
const pickStatusEl = document.getElementById("epg-pick-status")
const pickSearchEl = document.getElementById("epg-pick-search") as HTMLInputElement | null
const pickClearBtn = document.getElementById("epg-pick-clear")
const pickCurrentEl = document.getElementById("epg-pick-current")

if (mapDialog) {
  attachDialogSpatialNav(mapDialog, { defaultElement: "#epg-map-search" })
}
if (pickDialog) {
  attachDialogSpatialNav(pickDialog, { defaultElement: "#epg-pick-search" })
}

let activePlaylistId = ""
let activeIsM3U = false
let pickerChannelId: number | null = null

type MapFilter = "all" | "unmapped" | "auto" | "overridden"
let mapFilter: MapFilter = "all"

async function getActiveChannels(): Promise<Channel[]> {
  const entry = await getActiveEntry()
  if (!entry) {
    activePlaylistId = ""
    activeIsM3U = false
    return []
  }
  activePlaylistId = entry._id
  const creds = await loadCreds()
  activeIsM3U = isLikelyM3USource(creds.host, creds.user, creds.pass)
  const hit = getCached(activePlaylistId, activeIsM3U ? "m3u" : "live")
  if (!hit?.data) return []
  return hit.data as Channel[]
}

function escapeHtml(input: string) {
  return String(input || "").replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === "\"") return "&quot;"
    return "&#39;"
  })
}

function channelMatchesFilter(channel: Channel) {
  if (mapFilter === "all") return true
  const source = classifyTvgIdSource(channel, activePlaylistId)
  if (mapFilter === "overridden") return source === "override" || source === "name"
  if (mapFilter === "auto") return source === "tvg-id"
  if (mapFilter === "unmapped") return source === "none"
  return true
}

let cachedChannels: Channel[] = []
let cachedChannelsNorm: string[] = []
let filteredChannels: Channel[] = []

let channelById = new Map<number, Channel>()

const MAP_ROW_H = Math.max(44, Math.round(60 * getDensityFactor()))
const MAP_OVERSCAN = 6
let mapSpacer: HTMLElement | null = null
let mapRenderToken = 0
let mapScrollScheduled = false

let justChangedChannelId: number | null = null
let justChangedTimer: number | null = null
const JUST_CHANGED_MS = 1200

function flagJustChanged(channelId: number): void {
  justChangedChannelId = channelId
  if (justChangedTimer != null) window.clearTimeout(justChangedTimer)
  justChangedTimer = window.setTimeout(() => {
    justChangedChannelId = null
    justChangedTimer = null
  }, JUST_CHANGED_MS)
}

function recomputeCachedNorm() {
  cachedChannelsNorm = cachedChannels.map((channel) =>
    normalize(`${channel.name} ${channel.tvgId || ""}`)
  )
  channelById = new Map(cachedChannels.map((channel) => [channel.id, channel]))
}

function rebuildFiltered() {
  const search = normalize(mapSearchEl?.value || "")
  const tokens = search.length ? search.split(" ") : []
  filteredChannels = []
  for (let i = 0; i < cachedChannels.length; i++) {
    const channel = cachedChannels[i]
    if (!channelMatchesFilter(channel)) continue
    if (tokens.length) {
      const haystack = cachedChannelsNorm[i]
      if (!tokens.every((token) => haystack.includes(token))) continue
    }
    filteredChannels.push(channel)
  }
}

function renderMapList() {
  if (!mapListEl) return
  rebuildFiltered()

  if (!filteredChannels.length) {
    mapSpacer = null
    const messageKey =
      cachedChannels.length === 0
        ? "epg.map.listEmptyPlaylist"
        : "epg.map.listEmpty"
    mapListEl.innerHTML = `<div role="status" class="h-full flex flex-col items-center justify-center gap-3 p-6 text-sm text-fg-3 text-center">
      <span class="text-2xl text-fg-3/50" aria-hidden="true">${ICON_INFO}</span>
      <span data-i18n="${messageKey}">${escapeHtml(t(messageKey))}</span>
    </div>`
    if (mapStatusEl) {
      mapStatusEl.textContent = t("epg.map.listStatus", {
        shown: "0",
        total: cachedChannels.length.toLocaleString(),
      })
    }
    return
  }

  if (!mapSpacer || !mapListEl.contains(mapSpacer)) {
    mapListEl.innerHTML = ""
    mapSpacer = document.createElement("div")
    mapSpacer.className = "map-spacer relative w-full"
    mapListEl.appendChild(mapSpacer)
  }
  mapSpacer.style.height = `${filteredChannels.length * MAP_ROW_H}px`
  mapListEl.scrollTop = 0
  renderMapWindow()

  if (mapStatusEl) {
    mapStatusEl.textContent = t("epg.map.listStatus", {
      shown: filteredChannels.length.toLocaleString(),
      total: cachedChannels.length.toLocaleString(),
    })
  }
}

function renderMapWindow() {
  if (!mapListEl || !mapSpacer) return
  const token = ++mapRenderToken
  const viewportH = mapListEl.clientHeight || 400
  const scrollTop = mapListEl.scrollTop
  const startIdx = Math.max(
    0,
    Math.floor(scrollTop / MAP_ROW_H) - MAP_OVERSCAN
  )
  const endIdx = Math.min(
    filteredChannels.length,
    Math.ceil((scrollTop + viewportH) / MAP_ROW_H) + MAP_OVERSCAN
  )

  const labelOverridden = t("epg.map.statusOverridden")
  const labelAuto = t("epg.map.statusAuto")
  const labelAutoName = t("epg.map.statusAutoName")
  const labelUnmapped = t("epg.map.statusUnmapped")
  const labelNoTvgId = t("epg.map.noTvgId")
  const badgeBase =
    "shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium tabular-nums"
  const rowClassBase =
    "absolute left-0 right-0 flex items-center gap-3 px-3 py-2 text-left border-b border-line/40 " +
    "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none transition-colors map-row"

  const html: string[] = []
  for (let i = startIdx; i < endIdx; i++) {
    const channel = filteredChannels[i]
    const override = getChannelEpgOverride(activePlaylistId, channel.id)
    const source = classifyTvgIdSource(channel, activePlaylistId)
    const resolved = effectiveTvgId(channel, activePlaylistId)

    let badgeHtml: string
    if (source === "override") {
      badgeHtml = `<span class="${badgeBase} bg-accent-soft text-accent" data-i18n="epg.map.statusOverridden">${escapeHtml(labelOverridden)}</span>`
    } else if (source === "tvg-id") {
      badgeHtml = `<span class="${badgeBase} bg-good/10 text-good" data-i18n="epg.map.statusAuto">${escapeHtml(labelAuto)}</span>`
    } else if (source === "name") {
      badgeHtml = `<span class="${badgeBase} bg-warn/10 text-warn" data-i18n="epg.map.statusAutoName">${escapeHtml(labelAutoName)}</span>`
    } else {
      badgeHtml = `<span class="${badgeBase} bg-bad/10 text-bad" data-i18n="epg.map.statusUnmapped">${escapeHtml(labelUnmapped)}</span>`
    }

    const safeLogo = channel.logo ? safeHttpUrl(channel.logo) : null
    const logoHtml = safeLogo
      ? `<div class="h-9 w-9 shrink-0 rounded-md overflow-hidden ring-1 ring-inset ring-line bg-surface-2"><img src="${escapeHtml(safeLogo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="h-full w-full object-contain"></div>`
      : `<div class="h-9 w-9 shrink-0 rounded-md ring-1 ring-inset ring-line bg-surface-2"></div>`

    const tvgLabel = channel.tvgId || labelNoTvgId
    let subHtml: string
    if (override) {
      subHtml = `<div class="truncate text-2xs text-fg-3 tabular-nums"><span class="text-fg-3">${escapeHtml(tvgLabel)}</span> <span class="text-accent">↪ ${escapeHtml(override)}</span></div>`
    } else if (source === "name" && resolved && resolved !== channel.tvgId?.toLowerCase()) {
      subHtml = `<div class="truncate text-2xs text-fg-3 tabular-nums"><span class="text-fg-3">${escapeHtml(tvgLabel)}</span> <span class="text-warn">↪ ${escapeHtml(resolved)}</span></div>`
    } else {
      subHtml = `<div class="truncate text-2xs text-fg-3 tabular-nums">${escapeHtml(tvgLabel)}</div>`
    }

    const top = i * MAP_ROW_H
    const justChangedAttr =
      channel.id === justChangedChannelId ? ` data-just-changed="true"` : ""
    html.push(
      `<button type="button" data-channel-id="${channel.id}"${justChangedAttr} class="${rowClassBase}" style="top:${top}px;height:${MAP_ROW_H}px;">${logoHtml}<div class="flex-1 min-w-0"><div class="truncate text-sm font-medium text-fg">${escapeHtml(channel.name)}</div>${subHtml}</div>${badgeHtml}</button>`
    )
  }
  if (token !== mapRenderToken) return
  mapSpacer.innerHTML = html.join("")
  ;(window as any).SpatialNavigation?.makeFocusable?.()
}

function scheduleScrollRender() {
  if (mapScrollScheduled) return
  mapScrollScheduled = true
  requestAnimationFrame(() => {
    mapScrollScheduled = false
    renderMapWindow()
  })
}

// Delegated click handler - one listener on the list, not N on each row.
mapListEl?.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement)?.closest(
    "button[data-channel-id]"
  ) as HTMLButtonElement | null
  if (!target) return
  const channelId = Number(target.dataset.channelId)
  if (!Number.isFinite(channelId)) return
  const channel = channelById.get(channelId)
  if (channel) openPicker(channel)
})

mapListEl?.addEventListener("scroll", scheduleScrollRender, { passive: true })

mapSearchEl?.addEventListener("input", debounce(renderMapList, 80))

mapFilterEl?.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement)?.closest(
    "button[data-filter]"
  ) as HTMLButtonElement | null
  if (!target) return
  const next = target.dataset.filter as MapFilter
  if (!next || next === mapFilter) return
  mapFilter = next
  for (const btn of mapFilterEl.querySelectorAll("button[data-filter]")) {
    const isActive = (btn as HTMLElement).dataset.filter === next
    btn.setAttribute("aria-checked", String(isActive))
  }
  renderMapList()
})

mapCloseBtn?.addEventListener("click", () => mapDialog?.close?.())
mapDialog?.addEventListener("click", (event) => {
  if (event.target === mapDialog) mapDialog.close()
})

openBtn?.addEventListener("click", async () => {
  if (!mapDialog) return
  if (mapListEl) {
    mapListEl.innerHTML = `<div class="h-full flex items-center justify-center p-6 text-sm text-fg-3" data-i18n="common.loading">${escapeHtml(t("common.loading"))}</div>`
  }
  if (mapStatusEl) mapStatusEl.textContent = ""
  if (typeof mapDialog.showModal === "function") mapDialog.showModal()
  else mapDialog.setAttribute("open", "")

  cachedChannels = await getActiveChannels()
  if (!mapDialog.open) return
  requestAnimationFrame(() => {
    recomputeCachedNorm()
    renderMapList()
    ;(window as any).SpatialNavigation?.makeFocusable?.()
    mapSearchEl?.focus()
  })
})

// ---------------------------------------------------------------------------
// Picker dialog (pick a tvg-id for one channel)
// ---------------------------------------------------------------------------

function openPicker(channel: Channel) {
  if (!pickDialog) return
  pickerChannelId = channel.id
  const current = getChannelEpgOverride(activePlaylistId, channel.id)
  const original = (channel.tvgId || "").toLowerCase()
  // The button's own `disabled:opacity-50 disabled:cursor-not-allowed` classes
  // (see epg.astro) paint the disabled state - just toggle the attribute here.
  pickClearBtn?.toggleAttribute("disabled", !current)
  if (pickCurrentEl) {
    pickCurrentEl.textContent = t("epg.map.pickerCurrent", {
      channel: channel.name,
      tvgId: current || original || t("epg.map.noTvgId"),
    })
  }
  if (pickSearchEl) {
    // Pre-populate search with the channel name so close matches surface first.
    pickSearchEl.value = channel.name
  }
  if (typeof pickDialog.showModal === "function") pickDialog.showModal()
  else pickDialog.setAttribute("open", "")
  setTimeout(() => {
    ;(window as any).SpatialNavigation?.makeFocusable?.()
    pickSearchEl?.focus()
    pickSearchEl?.select?.()
  }, 0)
  renderPickList()
}

const PICKER_RENDER_CAP = 200

function renderPickList() {
  if (!pickListEl) return
  const available = getAvailableEpgChannels(activePlaylistId)
  if (!available.length) {
    pickListEl.innerHTML = `<div role="status" class="h-full flex flex-col items-center justify-center gap-3 p-6 text-sm text-fg-3 text-center">
      <span class="text-2xl text-fg-3/50" aria-hidden="true">${ICON_INFO}</span>
      <span data-i18n="epg.map.noEpgChannels">${escapeHtml(t("epg.map.noEpgChannels"))}</span>
    </div>`
    if (pickStatusEl) {
      pickStatusEl.removeAttribute("data-i18n")
      pickStatusEl.textContent = ""
    }
    return
  }
  if (pickStatusEl) pickStatusEl.removeAttribute("data-i18n")

  const search = normalize(pickSearchEl?.value || "")
  const tokens = search.length ? search.split(" ") : []
  const currentOverride = pickerChannelId != null
    ? getChannelEpgOverride(activePlaylistId, pickerChannelId)
    : ""

  // Score results so the best matches float to the top. Exact-id / exact-name
  // matches outrank prefix matches, which outrank substring matches.
  const scored: Array<{ entry: typeof available[number]; score: number }> = []
  for (const entry of available) {
    let score = 0
    if (tokens.length) {
      const idNorm = normalize(entry.tvgId)
      const nameNorm = normalize(entry.name)
      let tokenHits = 0
      for (const token of tokens) {
        if (nameNorm === token || idNorm === token) tokenHits += 3
        else if (nameNorm.startsWith(token) || idNorm.startsWith(token)) tokenHits += 2
        else if (nameNorm.includes(token) || idNorm.includes(token)) tokenHits += 1
        else { tokenHits = 0; break }
      }
      if (!tokenHits) continue
      score = tokenHits + Math.min(entry.count, 200) / 200
    } else {
      score = Math.min(entry.count, 200) / 200
    }
    scored.push({ entry, score })
  }
  scored.sort((first, second) => second.score - first.score)

  if (!scored.length) {
    pickListEl.innerHTML = `<div role="status" class="h-full flex flex-col items-center justify-center gap-3 p-6 text-sm text-fg-3 text-center">
      <span class="text-2xl text-fg-3/50" aria-hidden="true">${ICON_INFO}</span>
      <span data-i18n="epg.map.pickerEmpty">${escapeHtml(t("epg.map.pickerEmpty"))}</span>
    </div>`
    if (pickStatusEl) {
      pickStatusEl.textContent = t("epg.map.pickerStatus", {
        shown: "0",
        total: available.length.toLocaleString(),
      })
    }
    return
  }

  // Build the list as a single innerHTML string. ~5x faster than appendChild
  // loop for the 200-row payload, and avoids 200 per-row click listeners.
  const rowClass =
    "w-full flex items-center gap-3 px-3 py-2 text-left border-b border-line/40 last:border-b-0 " +
    "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none transition-colors pick-row"
  const html: string[] = []
  const cap = Math.min(scored.length, PICKER_RENDER_CAP)
  for (let i = 0; i < cap; i++) {
    const { entry } = scored[i]
    const isCurrent = entry.tvgId === currentOverride
    const highlight = isCurrent ? " bg-accent-soft/40" : ""
    const ariaCurrent = isCurrent ? ` aria-current="true"` : ""
    const countLabel = t("epg.map.programmeCount", {
      count: entry.count.toLocaleString(),
    })
    html.push(
      `<button type="button" data-tvg-id="${escapeHtml(entry.tvgId)}"${ariaCurrent} class="${rowClass}${highlight}"><div class="flex-1 min-w-0"><div class="truncate text-sm font-medium text-fg">${escapeHtml(entry.name)}</div><div class="truncate text-2xs text-fg-3 tabular-nums">${escapeHtml(entry.tvgId)}</div></div><span class="shrink-0 text-2xs text-fg-3 tabular-nums">${escapeHtml(countLabel)}</span></button>`
    )
  }
  pickListEl.innerHTML = html.join("")
  ;(window as any).SpatialNavigation?.makeFocusable?.()
  if (pickStatusEl) {
    pickStatusEl.textContent = t("epg.map.pickerStatus", {
      shown: cap.toLocaleString(),
      total: available.length.toLocaleString(),
    })
  }
}

// Delegated click handler for picker rows.
pickListEl?.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement)?.closest(
    "button[data-tvg-id]"
  ) as HTMLButtonElement | null
  if (!target) return
  if (pickerChannelId == null || !activePlaylistId) return
  const tvgId = target.dataset.tvgId
  if (!tvgId) return
  flagJustChanged(pickerChannelId)
  setChannelEpgOverride(activePlaylistId, pickerChannelId, tvgId)
  pickDialog?.close?.()
})

pickSearchEl?.addEventListener("input", debounce(renderPickList, 80))
pickCloseBtn?.addEventListener("click", () => pickDialog?.close?.())
pickDialog?.addEventListener("click", (event) => {
  if (event.target === pickDialog) pickDialog.close()
})
pickClearBtn?.addEventListener("click", () => {
  if (pickerChannelId == null || !activePlaylistId) return
  flagJustChanged(pickerChannelId)
  clearChannelEpgOverride(activePlaylistId, pickerChannelId)
  pickDialog?.close?.()
})

// Re-render the mapping list whenever the underlying state changes - either
// the override map (user picked) or the EPG itself (channels available).
document.addEventListener(CHANNEL_EPG_CHANGED_EVENT, () => {
  if (mapDialog?.open) renderMapList()
})
document.addEventListener(EPG_LOADED_EVENT, () => {
  if (mapDialog?.open) renderMapList()
  if (pickDialog?.open) renderPickList()
})
document.addEventListener("xt:active-changed", () => {
  // Active playlist switched; close any open dialog and reset.
  pickDialog?.close?.()
  mapDialog?.close?.()
  cachedChannels = []
  cachedChannelsNorm = []
  filteredChannels = []
  channelById = new Map()
  pickerChannelId = null
})
document.addEventListener(LOCALE_EVENT, () => {
  if (mapDialog?.open) renderMapList()
  if (pickDialog?.open) renderPickList()
})

log.log("[xt:epg-map] mapping module loaded")
