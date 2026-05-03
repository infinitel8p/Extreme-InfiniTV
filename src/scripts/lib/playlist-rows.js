import { selectEntry, removeEntry } from "./creds.js"
import { getNewestCacheTime } from "./cache.js"
import { ICON_TRASH, ICON_PENCIL, ICON_CHECK } from "./icons.js"
import { escapeHtml, fmtAge } from "./format.js"
import { t } from "./i18n.js"

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

  row.append(pick, edit, del)
  return row
}

/**
 * Returns the empty-state copy for a playlist list, translated to the active
 * locale. Keep as a function so the value re-evaluates on locale change.
 */
export function getPlaylistListEmptyCopy() {
  return t("list.noPlaylistsCta")
}
