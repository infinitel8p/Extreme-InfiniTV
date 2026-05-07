import { selectEntry, removeEntry, loadCreds, getActiveEntry } from "./creds.js"
import { getNewestCacheTime } from "./cache.js"
import {
  ICON_TRASH,
  ICON_PENCIL,
  ICON_CHECK,
  ICON_INFO,
  ICON_CHEVRON_DOWN,
} from "./icons.js"
import { escapeHtml, fmtAge } from "./format.js"
import { t } from "./i18n.js"
import {
  getPlaylistHealth,
  refreshPlaylistHealth,
  fmtAgo,
  fmtAbsDate,
} from "./playlist-health.ts"

/**
 * @param {{
 *   entry: any,
 *   isActive: boolean,
 *   density?: "compact" | "full",
 *   onAfterSelect?: () => void | Promise<void>,
 *   onAfterRemove?: () => void | Promise<void>,
 * }} opts
 */
export function renderPlaylistRow({
  entry,
  isActive,
  density = "compact",
  onAfterSelect,
  onAfterRemove,
}) {
  const isCompact = density === "compact"
  const ageLabel = fmtAge(getNewestCacheTime(entry._id))

  // Outer wrapper holds the visible row + the (initially hidden)
  // expandable health panel beneath it. Caller appends `outer` and gets
  // both for free.
  const outer = document.createElement("div")
  outer.className = "flex flex-col"

  const row = document.createElement("div")
  row.className = isCompact
    ? "relative flex items-stretch gap-0.5 pl-3 pr-1 transition-colors hover:bg-surface-2 focus-within:bg-surface-2"
    : "relative flex items-stretch gap-1 pl-4 pr-2 py-1 transition-colors hover:bg-surface-2 focus-within:bg-surface-2"

  if (isActive) {
    const rule = document.createElement("span")
    rule.className =
      "absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent"
    rule.setAttribute("aria-hidden", "true")
    row.appendChild(rule)
  }

  const subtitle = isCompact
    ? ""
    : entry.type === "xtream"
    ? `${entry.serverUrl} · ${entry.username}`
    : entry.url || ""

  const badgeSize = isCompact
    ? "h-5 min-w-10 px-1.5"
    : "h-6 min-w-12 px-2 tracking-wide"

  const pick = document.createElement("button")
  pick.type = "button"
  pick.className = isCompact
    ? "flex flex-1 items-center gap-2.5 py-2.5 text-left min-w-0 min-h-11 outline-none"
    : "flex flex-1 items-center gap-3 py-2 text-left min-w-0 min-h-11 outline-none"
  pick.dataset.id = entry._id
  pick.innerHTML = `
    <span class="inline-flex items-center justify-center rounded-md text-label font-semibold uppercase ring-1 shrink-0 ${badgeSize} ${
      entry.type === "xtream"
        ? "ring-accent/40 text-accent bg-accent-soft"
        : "ring-line text-fg-2 bg-surface-2"
    }">${entry.type === "xtream" ? "XT" : "M3U"}</span>
    <span class="flex flex-col min-w-0 flex-1 ${isCompact ? "" : "gap-0.5"}">
      <span class="truncate text-sm ${
        isActive ? "text-fg font-medium" : "text-fg-2"
      }">${escapeHtml(entry.title)}</span>
      ${
        subtitle
          ? `<span class="truncate text-2xs text-fg-3 font-mono">${escapeHtml(subtitle)}</span>`
          : ""
      }
      <span class="truncate text-2xs text-fg-3 ${
        ageLabel ? "tabular-nums" : "italic"
      }">${ageLabel ? `Updated ${ageLabel}` : "Not loaded yet"}</span>
    </span>
    ${
      isActive
        ? `<span class="check-draw text-accent shrink-0 inline-flex ${
            isCompact ? "text-sm" : "text-base"
          }">${ICON_CHECK}</span>`
        : ""
    }
  `
  pick.addEventListener("click", async () => {
    await selectEntry(entry._id)
    if (onAfterSelect) await onAfterSelect()
  })

  // Health panel below the row
  const panel = document.createElement("div")
  panel.id = `playlist-health-${entry._id}`
  panel.className = "hidden border-t border-line/50 bg-bg/40 px-4 py-3"
  panel.setAttribute("role", "region")
  panel.setAttribute("aria-label", t("playlist.healthAria", { title: entry.title }))

  const info = document.createElement("button")
  info.type = "button"
  info.title = t("playlist.healthToggle")
  info.setAttribute("aria-label", t("playlist.healthAria", { title: entry.title }))
  info.setAttribute("aria-expanded", "false")
  info.setAttribute("aria-controls", panel.id)
  info.className =
    "shrink-0 rounded-md px-1.5 py-2 text-fg-3 hover:text-fg hover:bg-surface focus:text-fg focus:bg-surface min-h-10 inline-flex items-center justify-center gap-0.5 transition-colors outline-none aria-expanded:text-fg"
  info.innerHTML =
    `<span class="inline-flex text-base">${ICON_INFO}</span>` +
    `<span class="inline-flex text-2xs transition-transform aria-expanded:rotate-180">${ICON_CHEVRON_DOWN}</span>`
  info.addEventListener("click", async (ev) => {
    ev.stopPropagation()
    const expanded = info.getAttribute("aria-expanded") === "true"
    if (expanded) {
      panel.classList.add("hidden")
      info.setAttribute("aria-expanded", "false")
      return
    }
    panel.classList.remove("hidden")
    info.setAttribute("aria-expanded", "true")
    paintPlaylistHealthInto(panel, entry)
  })

  const edit = document.createElement("a")
  edit.href = `/login?edit=${encodeURIComponent(entry._id)}`
  edit.title = "Edit"
  edit.setAttribute("aria-label", t("playlist.editAria", { title: entry.title }))
  edit.className =
    "shrink-0 rounded-md px-1.5 py-2 text-fg-3 hover:text-fg hover:bg-surface focus:text-fg focus:bg-surface min-h-10 inline-flex items-center justify-center transition-colors outline-none"
  edit.innerHTML = `<span class="inline-flex text-base">${ICON_PENCIL}</span>`

  const del = document.createElement("button")
  del.type = "button"
  del.title = "Remove"
  del.setAttribute("aria-label", t("playlist.removeAria", { title: entry.title }))
  del.className =
    "shrink-0 rounded-md px-1.5 py-2 text-fg-3 hover:text-bad hover:bg-bad/10 focus:text-bad focus:bg-bad/10 min-h-10 inline-flex items-center justify-center transition-colors outline-none"
  del.innerHTML = `<span class="inline-flex text-base">${ICON_TRASH}</span>`
  del.addEventListener("click", async (ev) => {
    ev.stopPropagation()
    if (!confirm(t("playlist.removeConfirm", { title: entry.title }))) return
    await removeEntry(entry._id)
    if (onAfterRemove) await onAfterRemove()
  })

  row.append(pick, info, edit, del)
  outer.append(row, panel)
  return outer
}

/**
 * Returns the empty-state copy for a playlist list, translated to the active
 * locale. Keep as a function so the value re-evaluates on locale change.
 */
export function getPlaylistListEmptyCopy() {
  return t("list.noPlaylistsCta")
}

// ---------------------------------------------------------------------------
// Health panel rendering (inline, per-row).
// ---------------------------------------------------------------------------

function fmtCount(n) {
  return Number.isFinite(n) ? n.toLocaleString() : "—"
}

function healthRow(label, value, tone) {
  const row = document.createElement("div")
  row.className =
    "flex items-center justify-between gap-3 py-1.5 border-b border-line/40 last:border-b-0 text-2xs"
  const dt = document.createElement("dt")
  dt.className = "text-fg-3"
  dt.textContent = label
  const dd = document.createElement("dd")
  dd.className =
    "tabular-nums text-right " +
    (tone === "good"
      ? "text-good"
      : tone === "warn"
      ? "text-warn"
      : tone === "bad"
      ? "text-bad"
      : "text-fg-2")
  if (value && typeof value === "object" && "nodeType" in value) {
    dd.appendChild(value)
  } else {
    dd.textContent = String(value ?? "—")
  }
  row.append(dt, dd)
  return row
}

/**
 * Render the eight-row health snapshot for `entry` into `panel`. Replaces
 * the panel's children. Wires a Refresh button that re-runs ensureUserInfo
 * and repaints.
 */
function paintPlaylistHealthInto(panel, entry) {
  const h = getPlaylistHealth(entry._id)

  const accountTone =
    h.account.status === "active"
      ? "good"
      : h.account.status === "expired"
      ? "bad"
      : h.account.status === "inactive"
      ? "warn"
      : "neutral"
  const accountLabel =
    h.account.status === "active"
      ? t("settings.health.accountActive")
      : h.account.status === "expired"
      ? t("settings.health.accountExpired")
      : h.account.status === "inactive"
      ? t("settings.health.accountInactive")
      : t("settings.health.accountUnknown")

  const conns =
    h.account.activeConnections != null && h.account.maxConnections != null
      ? `${h.account.activeConnections} / ${h.account.maxConnections}`
      : "—"
  const connsTone =
    h.account.maxConnections && h.account.activeConnections != null
      ? h.account.activeConnections >= h.account.maxConnections
        ? "warn"
        : "good"
      : "neutral"

  let expiryText = "—"
  let expiryTone = "neutral"
  if (h.account.expDateMs) {
    const days = h.account.daysUntilExpiry
    const date = fmtAbsDate(h.account.expDateMs)
    if (days != null && days < 0) {
      expiryText = t("settings.health.expiredOn", { date })
      expiryTone = "bad"
    } else if (days != null && days <= 7) {
      expiryText = t("settings.health.expiresInDays", { days, date })
      expiryTone = "warn"
    } else if (days != null) {
      expiryText = t("settings.health.expiresInDays", { days, date })
      expiryTone = "good"
    } else {
      expiryText = date
      expiryTone = "neutral"
    }
  }

  const liveText = h.catalog.live.fetchedAt
    ? `${fmtCount(h.catalog.live.itemCount)} · ${fmtAgo(h.catalog.live.fetchedAt)}`
    : "—"
  const vodText = h.catalog.vod.fetchedAt
    ? `${fmtCount(h.catalog.vod.itemCount)} · ${fmtAgo(h.catalog.vod.fetchedAt)}`
    : "—"
  const seriesText = h.catalog.series.fetchedAt
    ? `${fmtCount(h.catalog.series.itemCount)} · ${fmtAgo(h.catalog.series.fetchedAt)}`
    : "—"

  const epgText = h.epg.fetchedAt
    ? `${fmtCount(h.epg.channelsWithProgrammes)} · ${fmtAgo(h.epg.fetchedAt)}`
    : "—"

  const provText =
    h.provider.successes || h.provider.failures
      ? `${h.provider.successes} ok · ${h.provider.failures} fail · ${t(
          "settings.health.lastOk"
        )} ${fmtAgo(h.provider.lastSuccessAt)}`
      : "—"
  const provTone =
    h.provider.failures > 0 &&
    h.provider.lastFailureAt > h.provider.lastSuccessAt
      ? "warn"
      : h.provider.successes
      ? "good"
      : "neutral"

  const list = document.createElement("dl")
  list.className = "flex flex-col gap-0"

  list.appendChild(healthRow(t("settings.health.account"), accountLabel, accountTone))
  list.appendChild(healthRow(t("settings.health.connections"), conns, connsTone))
  list.appendChild(healthRow(t("settings.health.expiry"), expiryText, expiryTone))
  list.appendChild(
    healthRow(
      t("settings.health.live"),
      liveText,
      h.catalog.live.fetchedAt ? "good" : "neutral"
    )
  )
  list.appendChild(
    healthRow(
      t("settings.health.vod"),
      vodText,
      h.catalog.vod.fetchedAt ? "good" : "neutral"
    )
  )
  list.appendChild(
    healthRow(
      t("settings.health.series"),
      seriesText,
      h.catalog.series.fetchedAt ? "good" : "neutral"
    )
  )
  list.appendChild(
    healthRow(
      t("settings.health.epg"),
      epgText,
      h.epg.fetchedAt ? "good" : "neutral"
    )
  )
  list.appendChild(healthRow(t("settings.health.provider"), provText, provTone))
  if (h.provider.lastError && h.provider.failures > 0) {
    const errEl = document.createElement("span")
    errEl.className = "text-bad break-all"
    errEl.textContent = h.provider.lastError
    list.appendChild(healthRow(t("settings.health.lastError"), errEl, "bad"))
  }

  const refresh = document.createElement("button")
  refresh.type = "button"
  refresh.textContent = t("settings.health.refresh")
  refresh.className =
    "mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line bg-bg px-2.5 py-1 text-2xs text-fg-2 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent transition-colors"
  refresh.addEventListener("click", async (ev) => {
    ev.stopPropagation()
    refresh.setAttribute("disabled", "")
    refresh.classList.add("opacity-60")
    try {
      const active = await getActiveEntry()
      if (active?._id === entry._id) {
        const creds = await loadCreds()
        await refreshPlaylistHealth(entry._id, creds)
      }
    } catch {}
    refresh.removeAttribute("disabled")
    refresh.classList.remove("opacity-60")
    paintPlaylistHealthInto(panel, entry)
  })

  panel.replaceChildren(list, refresh)
}
