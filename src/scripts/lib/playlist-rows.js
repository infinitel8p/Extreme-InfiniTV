import { selectEntry, removeEntry, loadCreds, getActiveEntry } from "./creds.js"
import { getNewestCacheTime, getCached } from "./cache.js"
import { buildLiveStreamUrl } from "./stream-urls.ts"
import {
  ICON_TRASH,
  ICON_PENCIL,
  ICON_CHECK,
  ICON_INFO,
  ICON_DOWNLOAD,
} from "./icons.js"
import { escapeHtml, fmtAge } from "./format.js"
import { t } from "./i18n.js"
import { redactUrl, log } from "./log.js"
import { confirmDialog } from "./confirm-dialog.ts"
import { toastSuccess, toastError } from "./toast.ts"
import {
  getPlaylistHealth,
  refreshPlaylistHealth,
  fmtAgo,
  fmtAbsDate,
} from "./playlist-health.ts"

function editHrefFor(entry) {
  return entry.type === "custom"
    ? `/playlist-editor?id=${encodeURIComponent(entry._id)}`
    : `/login?edit=${encodeURIComponent(entry._id)}`
}

const COMPACT_ICON_ACTION_CLASS =
  "inline-flex items-center justify-center rounded-lg border border-line bg-bg h-8 w-8 text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:border-accent transition-colors outline-none"

/** Resolve `entry`'s live catalog and save it as an .m3u file. */
async function exportEntryM3U(entry) {
  try {
    const [{ buildM3UEntriesForEntry, saveM3UText, sanitizeFilename }, { serializeM3U }] = await Promise.all([
      import("./export-m3u.ts"),
      import("./m3u-serializer.ts"),
    ])
    const { entries, skippedCount } = await buildM3UEntriesForEntry(entry)
    if (!entries.length) {
      toastError(t("editor.toastExportEmpty"))
      return
    }
    const text = serializeM3U(entries, { epgUrl: entry.epgUrl || null })
    const filename = `${sanitizeFilename(entry.title || "playlist")}.m3u`
    const outcome = await saveM3UText(filename, text)
    if (outcome.cancelled) return
    toastSuccess(t("editor.toastExportDone"), {
      description: outcome.savedTo || undefined,
    })
    if (skippedCount > 0) {
      toastError(t("editor.toastExportSkipped", { count: skippedCount }))
    }
  } catch (e) {
    log.error("[xt:playlist-rows] export failed:", e)
    toastError(t("editor.toastExportFail"), { description: (e && e.message) || undefined })
  }
}

/** First cached channel's stream URL, so "Run diagnostic" can probe playback without an extra catalog fetch. Checks "live" then falls back to "m3u", same as playlist-health.ts. */
function resolveSampleStreamUrl(entry) {
  try {
    const live = getCached(entry._id, "live")
    const hit = live && Array.isArray(live.data) && live.data.length ? live : getCached(entry._id, "m3u")
    const firstChannel = Array.isArray(hit?.data) ? hit.data[0] : null
    if (!firstChannel) return null
    if (typeof firstChannel.url === "string" && firstChannel.url) return firstChannel.url
    if (firstChannel.id != null && entry.type === "xtream") {
      return buildLiveStreamUrl(
        { host: entry.serverUrl, port: "", user: entry.username, pass: entry.password },
        firstChannel.id,
        entry.liveContainer
      )
    }
    return null
  } catch {
    return null
  }
}

function buildExportButton(entry, isCompact) {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.title = t("editor.exportM3uAction")
  btn.setAttribute("aria-label", t("editor.exportM3uAria", { title: entry.title }))
  btn.className = isCompact
    ? COMPACT_ICON_ACTION_CLASS
    : "shrink-0 self-center rounded-md size-10 p-0 text-fg-3 hover:text-fg hover:bg-surface focus:text-fg focus:bg-surface inline-flex items-center justify-center transition-colors outline-none"
  btn.innerHTML = `<span class="inline-flex text-sm">${ICON_DOWNLOAD}</span>`
  btn.addEventListener("click", async (ev) => {
    ev.stopPropagation()
    if (btn.disabled) return
    btn.disabled = true
    await exportEntryM3U(entry)
    btn.disabled = false
  })
  return btn
}

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
    : entry.type === "local-m3u"
    ? entry.sourceName || ""
    : entry.url || ""

  const badgeSize = isCompact
    ? "h-5 min-w-10 px-1.5"
    : "h-6 min-w-12 px-2 tracking-wide"

  const badgeLabel =
    entry.type === "xtream"
      ? "XT"
      : entry.type === "local-m3u"
      ? "FILE"
      : entry.type === "custom"
      ? "CUST"
      : "M3U"

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
    }">${badgeLabel}</span>
    <span class="flex flex-col min-w-0 flex-1 ${isCompact ? "" : "gap-0.5"}">
      <span class="flex items-center gap-1 min-w-0">
        ${
          entry.emoji
            ? `<span class="shrink-0 text-sm leading-none" aria-hidden="true">${escapeHtml(entry.emoji)}</span>`
            : ""
        }
        <span class="truncate text-sm flex-1 min-w-0 ${
          isActive ? "text-fg font-medium" : "text-fg-2"
        }">${escapeHtml(entry.title)}</span>
      </span>
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
    "shrink-0 self-center rounded-md size-10 p-0 text-fg-3 hover:text-fg hover:bg-surface focus:text-fg focus:bg-surface inline-flex items-center justify-center transition-colors outline-none aria-expanded:text-fg"
  info.innerHTML = `<span class="inline-flex text-base">${ICON_INFO}</span>`
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
    paintPlaylistHealthInto(panel, entry, {
      isCompact,
      onAfterRemove,
    })
  })

  if (!isCompact) {
    const edit = document.createElement("a")
    edit.href = editHrefFor(entry)
    edit.title = "Edit"
    edit.setAttribute("aria-label", t("playlist.editAria", { title: entry.title }))
    edit.className =
      "shrink-0 self-center rounded-md size-10 p-0 text-fg-3 hover:text-fg hover:bg-surface focus:text-fg focus:bg-surface inline-flex items-center justify-center transition-colors outline-none"
    edit.innerHTML = `<span class="inline-flex text-base">${ICON_PENCIL}</span>`

    const exportBtn = buildExportButton(entry, false)

    const del = document.createElement("button")
    del.type = "button"
    del.title = "Remove"
    del.setAttribute("aria-label", t("playlist.removeAria", { title: entry.title }))
    del.className =
      "shrink-0 self-center rounded-md size-10 p-0 text-fg-3 hover:text-bad hover:bg-bad/10 focus:text-bad focus:bg-bad/10 inline-flex items-center justify-center transition-colors outline-none"
    del.innerHTML = `<span class="inline-flex text-base">${ICON_TRASH}</span>`
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation()
      const ok = await confirmDialog({
        title: t("playlist.removeAria", { title: entry.title }),
        message: t("playlist.removeConfirm", { title: entry.title }),
        confirmLabel: t("common.delete"),
        destructive: true,
      })
      if (!ok) return
      await removeEntry(entry._id)
      if (onAfterRemove) await onAfterRemove()
    })
    row.append(pick, info, edit, exportBtn, del)
  } else {
    row.append(pick, info)
  }

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
  return Number.isFinite(n) ? n.toLocaleString() : "-"
}

function healthRow(label, value, tone, title) {
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
      : tone === "unmeasured"
      ? "text-fg-3 italic"
      : "text-fg-2")
  if (value && typeof value === "object" && "nodeType" in value) {
    dd.appendChild(value)
  } else {
    dd.textContent = String(value ?? "-")
  }
  if (title) dd.title = title
  row.append(dt, dd)
  return row
}

/**
 * Render the eight-row health snapshot for `entry` into `panel`. Replaces
 * the panel's children. Wires a Refresh button that re-runs ensureUserInfo
 * and repaints. In compact mode (sidebar switcher) also surfaces Edit +
 * Delete buttons here, since the row no longer renders them inline.
 *
 * @param {HTMLElement} panel
 * @param {any} entry
 * @param {{ isCompact?: boolean, onAfterRemove?: () => void | Promise<void> }} [opts]
 */
function paintPlaylistHealthInto(panel, entry, opts = {}) {
  const { isCompact = false, onAfterRemove } = opts
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
      : "-"
  const connsTone =
    h.account.maxConnections && h.account.activeConnections != null
      ? h.account.activeConnections >= h.account.maxConnections
        ? "warn"
        : "good"
      : "neutral"

  let expiryText = "-"
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
    : "-"
  const vodText = h.catalog.vod.fetchedAt
    ? `${fmtCount(h.catalog.vod.itemCount)} · ${fmtAgo(h.catalog.vod.fetchedAt)}`
    : "-"
  const seriesText = h.catalog.series.fetchedAt
    ? `${fmtCount(h.catalog.series.itemCount)} · ${fmtAgo(h.catalog.series.fetchedAt)}`
    : "-"

  const epgText = h.epg.fetchedAt
    ? `${fmtCount(h.epg.channelsWithProgrammes)} · ${fmtAgo(h.epg.fetchedAt)}`
    : "-"

  const provText =
    h.provider.successes || h.provider.failures
      ? `${h.provider.successes} ok · ${h.provider.failures} fail · ${t(
          "settings.health.lastOk"
        )} ${fmtAgo(h.provider.lastSuccessAt)}`
      : "-"
  const provTone =
    h.provider.failures > 0 &&
    h.provider.lastFailureAt > h.provider.lastSuccessAt
      ? "warn"
      : h.provider.successes
      ? "good"
      : "unmeasured"

  // No i18n key for "not loaded on this page" - reuse the panel helper copy as a tooltip.
  const notLoadedHereTitle = t("settings.health.helper")

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
      h.epg.fetchedAt ? "good" : "unmeasured",
      h.epg.fetchedAt ? undefined : notLoadedHereTitle
    )
  )
  list.appendChild(
    healthRow(
      t("settings.health.provider"),
      provText,
      provTone,
      provTone === "unmeasured" ? notLoadedHereTitle : undefined
    )
  )
  if (h.provider.lastError && h.provider.failures > 0) {
    const errEl = document.createElement("span")
    errEl.className = "text-bad break-all"
    errEl.textContent = redactUrl(h.provider.lastError)
    list.appendChild(healthRow(t("settings.health.lastError"), errEl, "bad"))
  }

  const refresh = document.createElement("button")
  refresh.type = "button"
  refresh.textContent = t("settings.health.refresh")
  refresh.className =
    "inline-flex items-center gap-1.5 rounded-lg border border-line bg-bg px-2.5 py-1 text-2xs text-fg-2 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent transition-colors"
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
    paintPlaylistHealthInto(panel, entry, opts)
  })

  // Per-playlist "Run diagnostic" button. Shown for xtream and m3u entries
  // (local-m3u has nothing remote to probe). Result renders inside the
  // health panel below the existing rows so the user doesn't lose context.
  //
  // Reuse the previous result element across repaints (Refresh button calls
  // paintPlaylistHealthInto again, which would otherwise drop the diagnostic
  // panel the user just ran).
  const supportsDiagnostic = entry.type === "xtream" || entry.type === "m3u"
  let diagnosticResultEl = panel.querySelector("[data-diagnostic-result]")
  if (!diagnosticResultEl) {
    diagnosticResultEl = document.createElement("div")
    diagnosticResultEl.setAttribute("data-diagnostic-result", "")
    diagnosticResultEl.setAttribute("role", "status")
    diagnosticResultEl.setAttribute("aria-live", "polite")
    diagnosticResultEl.setAttribute("aria-atomic", "false")
    diagnosticResultEl.className = "mt-3 hidden"
  }
  let diagnostic = null
  if (supportsDiagnostic) {
    diagnostic = document.createElement("button")
    diagnostic.type = "button"
    diagnostic.textContent = t("diagnostic.runFull")
    diagnostic.className = refresh.className
    diagnostic.addEventListener("click", async (ev) => {
      ev.stopPropagation()
      diagnostic.setAttribute("disabled", "")
      diagnostic.classList.add("opacity-60")
      diagnosticResultEl.classList.remove("hidden")
      diagnosticResultEl.className =
        "mt-3 flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-sm leading-relaxed text-fg-2"
      diagnosticResultEl.textContent = t("diagnostic.running")
      try {
        const { runXtreamDiagnostic, runM3UDiagnostic, renderDiagnosticInto } =
          await import("./diagnostic.ts")
        // Same incremental render as the login page so users see rows
        // trickle in rather than staring at "Running…" for 10 seconds.
        const onProgress = (partialSteps) => {
          renderDiagnosticInto(diagnosticResultEl, {
            steps: partialSteps,
            verdict: "running",
            verdictMessage: t("diagnostic.running"),
          })
        }
        const runOptions = {
          onProgress,
          entry: {
            epgUrl: entry.epgUrl,
            additionalEpgUrls: entry.additionalEpgUrls,
            disableProviderEpg: entry.disableProviderEpg,
            liveContainer: entry.liveContainer,
            type: entry.type,
          },
          sampleStreamUrl: resolveSampleStreamUrl(entry) || undefined,
        }
        let result
        if (entry.type === "xtream") {
          result = await runXtreamDiagnostic({
            serverUrl: entry.serverUrl,
            username: entry.username,
            password: entry.password,
          }, runOptions)
        } else {
          result = await runM3UDiagnostic(entry.url, runOptions)
        }
        renderDiagnosticInto(diagnosticResultEl, result)
      } catch (error) {
        diagnosticResultEl.textContent = redactUrl(error?.message || error)
      } finally {
        diagnostic.removeAttribute("disabled")
        diagnostic.classList.remove("opacity-60")
        // Repaint so the rows above reflect the requests the diagnostic just made.
        paintPlaylistHealthInto(panel, entry, opts)
      }
    })
  }

  const footer = document.createElement("div")
  footer.className = "mt-3 flex items-center justify-between gap-2 flex-wrap"
  const footerLeft = document.createElement("div")
  footerLeft.className = "inline-flex items-center gap-2"
  footerLeft.appendChild(refresh)
  if (diagnostic) footerLeft.appendChild(diagnostic)
  footer.appendChild(footerLeft)

  if (isCompact) {
    const actions = document.createElement("div")
    actions.className = "inline-flex items-center gap-1"

    const edit = document.createElement("a")
    edit.href = editHrefFor(entry)
    edit.title = t("playlist.editAria", { title: entry.title })
    edit.setAttribute("aria-label", t("playlist.editAria", { title: entry.title }))
    edit.className = COMPACT_ICON_ACTION_CLASS
    edit.innerHTML = `<span class="inline-flex text-sm">${ICON_PENCIL}</span>`

    const exportBtn = buildExportButton(entry, true)

    const del = document.createElement("button")
    del.type = "button"
    del.title = t("playlist.removeAria", { title: entry.title })
    del.setAttribute("aria-label", t("playlist.removeAria", { title: entry.title }))
    del.className =
      "inline-flex items-center justify-center rounded-lg border border-line bg-bg h-8 w-8 text-fg-2 hover:bg-bad/10 hover:text-bad hover:border-bad/40 focus-visible:bg-bad/10 focus-visible:text-bad focus-visible:border-bad/40 transition-colors outline-none"
    del.innerHTML = `<span class="inline-flex text-sm">${ICON_TRASH}</span>`
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation()
      const ok = await confirmDialog({
        title: t("playlist.removeAria", { title: entry.title }),
        message: t("playlist.removeConfirm", { title: entry.title }),
        confirmLabel: t("common.delete"),
        destructive: true,
      })
      if (!ok) return
      await removeEntry(entry._id)
      if (onAfterRemove) await onAfterRemove()
    })

    actions.append(edit, exportBtn, del)
    footer.appendChild(actions)
  }

  if (supportsDiagnostic) {
    panel.replaceChildren(list, footer, diagnosticResultEl)
  } else {
    panel.replaceChildren(list, footer)
  }
}
