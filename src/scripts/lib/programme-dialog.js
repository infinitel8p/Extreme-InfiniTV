// Shared "programme detail" dialog used by Live TV's EPG panel and the
// /epg grid. The dialog is mounted lazily on first open and reused.
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"

const DIALOG_ID = "programme-dialog"

/** @type {HTMLDialogElement | null} */
let dlg = null
/** Last opts passed to openProgrammeDialog, kept so we can re-render the
 *  translated bits (status, "untitled", "no description") if the locale
 *  changes while the dialog is open. */
let lastOpts = null

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;"
  )
}

function fmtTimeRange(start, stop) {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })
    return `${fmt.format(start)}–${fmt.format(stop)}`
  } catch {
    return ""
  }
}

function fmtDateLine(start) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(start)
  } catch {
    return ""
  }
}

function fmtDuration(start, stop) {
  const ms = Math.max(0, stop - start)
  const total = Math.round(ms / 60000)
  if (!total) return ""
  const h = Math.floor(total / 60)
  const m = total % 60
  if (!h) return `${m}m`
  if (!m) return `${h}h`
  return `${h}h ${m}m`
}

function ensureDialog() {
  if (dlg) return dlg
  if (typeof document === "undefined") return null
  const existing = document.getElementById(DIALOG_ID)
  if (existing instanceof HTMLDialogElement) {
    dlg = existing
    return dlg
  }

  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(40rem,calc(100vw-2rem))] max-h-[min(80dvh,42rem)]",
    "backdrop:bg-black/60",
  ].join(" ")
  node.innerHTML = `
    <div class="flex flex-col h-full p-5 sm:p-6 gap-4">
      <header class="flex items-start justify-between gap-3 shrink-0">
        <div class="flex flex-col gap-1 min-w-0">
          <div data-role="meta" class="text-eyebrow font-medium uppercase tracking-widest text-fg-3"></div>
          <h2 id="${DIALOG_ID}-title" data-role="title" class="text-xl font-semibold tracking-[-0.01em]"></h2>
          <div data-role="time" class="text-sm text-fg-2 tabular-nums"></div>
        </div>
        <button
          data-role="close"
          type="button"
          aria-label="Close"
          data-i18n-attr="aria-label:common.close"
          class="rounded-lg border border-line min-h-11 px-3 py-1.5 text-xs text-fg-2 shrink-0
                 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent">
          <span data-i18n="common.close">Close</span>
        </button>
      </header>
      <div data-role="desc" class="text-sm text-fg-2 leading-relaxed overflow-auto custom-scroll min-h-0"></div>
      <footer data-role="footer" class="flex flex-wrap items-center gap-2 pt-1 shrink-0 hidden">
        <button
          data-role="watch"
          type="button"
          data-i18n="programme.watchNow"
          class="btn">
          Watch now
        </button>
      </footer>
    </div>
  `
  document.body.appendChild(node)
  attachDialogSpatialNav(node)

  node.addEventListener("click", (e) => {
    if (e.target === node) node.close()
  })
  node.querySelector("[data-role='close']")?.addEventListener("click", () => node.close())

  document.addEventListener(LOCALE_EVENT, () => {
    if (node.open && lastOpts) renderProgramme(node, lastOpts)
  })

  dlg = node
  return dlg
}

function renderProgramme(node, opts) {
  const now = Date.now()
  const isLive = opts.start <= now && now < opts.stop
  const isUpcoming = opts.start > now
  const status = isLive ? t("programme.live") : isUpcoming ? t("programme.upcoming") : t("programme.ended")

  const metaParts = []
  if (opts.channelName) metaParts.push(opts.channelName)
  metaParts.push(status)
  const dateLine = fmtDateLine(opts.start)
  if (dateLine && !isLive) metaParts.push(dateLine)

  const meta = node.querySelector("[data-role='meta']")
  const title = node.querySelector("[data-role='title']")
  const time = node.querySelector("[data-role='time']")
  const desc = node.querySelector("[data-role='desc']")

  if (meta) meta.textContent = metaParts.join(" · ")
  if (title) title.textContent = opts.title || t("programme.untitled")
  if (time) {
    const range = fmtTimeRange(opts.start, opts.stop)
    const dur = fmtDuration(opts.start, opts.stop)
    time.textContent = dur ? `${range} · ${dur}` : range
  }
  if (desc) {
    desc.innerHTML = opts.desc
      ? `<p>${escapeHtml(opts.desc).replace(/\n+/g, "</p><p>")}</p>`
      : `<p class="text-fg-3 italic">${escapeHtml(t("detail.noDescription"))}</p>`
  }
}

/**
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} [opts.desc]
 * @param {number} opts.start - epoch ms
 * @param {number} opts.stop  - epoch ms
 * @param {string} [opts.channelName]
 * @param {number|string} [opts.channelId]
 * @param {() => void} [opts.onWatch] - if omitted and channelId is set, navigates to /livetv?channel=<id>
 */
export function openProgrammeDialog(opts) {
  const node = ensureDialog()
  if (!node) return

  lastOpts = opts
  renderProgramme(node, opts)

  const now = Date.now()
  const isLive = opts.start <= now && now < opts.stop
  const watch = /** @type {HTMLButtonElement | null} */ (
    node.querySelector("[data-role='watch']")
  )
  const footer = /** @type {HTMLElement | null} */ (
    node.querySelector("[data-role='footer']")
  )
  let showWatch = false
  if (watch) {
    showWatch = isLive && (opts.onWatch != null || opts.channelId != null)
    if (showWatch) {
      watch.onclick = () => {
        node.close()
        if (opts.onWatch) opts.onWatch()
        else if (opts.channelId != null) {
          window.location.href = `/livetv?channel=${encodeURIComponent(
            String(opts.channelId)
          )}`
        }
      }
    } else {
      watch.onclick = null
    }
  }
  footer?.classList.toggle("hidden", !showWatch)

  if (!node.open) {
    if (typeof node.showModal === "function") node.showModal()
    else node.setAttribute("open", "")
    node.addEventListener("close", () => { lastOpts = null }, { once: true })
  }

  requestAnimationFrame(() => {
    const target = /** @type {HTMLElement | null} */ (
      showWatch
        ? node.querySelector("[data-role='watch']")
        : node.querySelector("[data-role='close']")
    )
    target?.focus?.({ preventScroll: true })
  })
}

export function closeProgrammeDialog() {
  dlg?.close?.()
}
