// Lazy-mounted "Test stream" diagnostic dialog.
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { diagnoseStream, summarizeReport } from "@/scripts/lib/stream-diagnostic.js"

const DIALOG_ID = "stream-diagnostic-dialog"

/** @type {HTMLDialogElement | null} */
let dlg = null

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;"
  )
}

function fmtBytes(n) {
  if (!n) return "-"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtMs(n) {
  if (n == null) return "-"
  if (n < 1000) return `${n} ms`
  return `${(n / 1000).toFixed(2)} s`
}

function ensureDialog() {
  if (dlg) return dlg
  if (typeof document === "undefined") return null

  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(40rem,calc(100vw-2rem))] max-h-[min(85dvh,46rem)]",
    "backdrop:bg-black/60",
  ].join(" ")
  node.innerHTML = `
    <div class="flex flex-col h-full p-5 sm:p-6 gap-4">
      <header class="flex items-start justify-between gap-3 shrink-0">
        <div class="flex flex-col gap-1 min-w-0">
          <div data-role="eyebrow" class="text-eyebrow font-medium uppercase tracking-widest text-fg-3">Test stream</div>
          <h2 id="${DIALOG_ID}-title" data-role="title" class="text-xl font-semibold tracking-[-0.01em] truncate"></h2>
          <div data-role="url" class="text-2xs text-fg-3 break-all font-mono"></div>
        </div>
        <button
          data-role="close"
          type="button"
          aria-label="Close"
          class="rounded-lg border border-line min-h-11 px-3 py-1.5 text-xs text-fg-2 shrink-0
                 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent">
          Close
        </button>
      </header>

      <div data-role="verdict" class="rounded-xl border px-3 py-2 text-sm flex items-center gap-2"></div>

      <div data-role="report" class="overflow-auto custom-scroll min-h-0 flex flex-col gap-3 text-sm"></div>

      <footer class="flex flex-wrap items-center gap-2 pt-1 shrink-0">
        <button
          data-role="copy"
          type="button"
          class="btn">
          Copy report
        </button>
        <button
          data-role="rerun"
          type="button"
          class="btn ml-auto">
          Run again
        </button>
      </footer>
    </div>
  `
  document.body.appendChild(node)
  attachDialogSpatialNav(node)

  node.addEventListener("click", (event) => {
    if (event.target === node) node.close()
  })
  node.querySelector("[data-role='close']")?.addEventListener("click", () => node.close())

  dlg = node
  return dlg
}

function renderStage(label, content) {
  return `
    <section class="rounded-xl border border-line bg-bg p-3 flex flex-col gap-1.5">
      <div class="text-eyebrow font-medium uppercase tracking-widest text-fg-3">${escapeHtml(label)}</div>
      <div class="text-sm text-fg-2 leading-relaxed">${content}</div>
    </section>
  `
}

function renderHead(head) {
  if (!head) return `<span class="text-fg-3">Pending…</span>`
  if (head.error) {
    return `<span class="text-bad">${escapeHtml(head.error)}</span>` +
      ` <span class="text-fg-3">(${escapeHtml(head.method)}, ${fmtMs(head.latencyMs)})</span>`
  }
  const status = head.ok
    ? `<span class="text-ok font-semibold tabular-nums">${head.status} ${escapeHtml(head.statusText)}</span>`
    : `<span class="text-bad font-semibold tabular-nums">${head.status} ${escapeHtml(head.statusText)}</span>`
  const ct = head.contentType
    ? `<div class="text-2xs text-fg-3 font-mono break-all">${escapeHtml(head.contentType)}</div>`
    : ""
  const len = head.contentLength
    ? `<div class="text-2xs text-fg-3 tabular-nums">Length ${fmtBytes(head.contentLength)}</div>`
    : ""
  const meta = `<div class="text-2xs text-fg-3 tabular-nums">${escapeHtml(head.method)} · ${fmtMs(head.latencyMs)}</div>`
  const fallback = head.fallback
    ? `<div class="text-2xs text-warn">HEAD rejected (${escapeHtml(head.fallback)}) - used range GET fallback.</div>`
    : ""
  const cors = renderCorsHeaders(head.headers)
  return `${status}${ct}${len}${meta}${fallback}${cors}`
}

function renderCorsHeaders(headers) {
  if (!headers || typeof headers !== "object") return ""
  const corsKeys = ["access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-methods", "access-control-allow-headers"]
  const corsEntries = Object.entries(headers).filter(([k]) => corsKeys.includes(k.toLowerCase()))
  if (!corsEntries.length) return ""
  const rows = corsEntries.map(([k, v]) =>
    `<div class="text-2xs text-fg-3 font-mono"><span class="text-fg-2">${escapeHtml(k)}:</span> ${escapeHtml(String(v))}</div>`
  ).join("")
  return `<details class="mt-1"><summary class="text-2xs text-fg-3 cursor-pointer hover:text-fg-2">CORS headers (${corsEntries.length})</summary><div class="mt-1">${rows}</details>`
}

function renderPlaylist(pl) {
  if (!pl) return `<span class="text-fg-3">Pending…</span>`
  if (pl.error) {
    return `<span class="text-bad">${escapeHtml(pl.error)}</span>`
  }
  const heading = pl.isMaster
    ? `Master playlist · ${pl.variantCount} variant${pl.variantCount === 1 ? "" : "s"}`
    : `Media playlist · ${pl.segmentCount} segment${pl.segmentCount === 1 ? "" : "s"}`
  const top = pl.topVariant
    ? `<div class="text-2xs text-fg-3 tabular-nums">Top variant: ${pl.topVariant.resolution || "?"} @ ${(pl.topVariant.bandwidth / 1000).toFixed(0)} kbps${pl.topVariant.codecs ? ` (${escapeHtml(pl.topVariant.codecs)})` : ""}</div>`
    : ""
  const td = pl.targetDuration
    ? `<div class="text-2xs text-fg-3 tabular-nums">Target segment duration: ${pl.targetDuration}s</div>`
    : ""
  const total = pl.totalDuration
    ? `<div class="text-2xs text-fg-3 tabular-nums">Window: ${pl.totalDuration.toFixed(1)}s</div>`
    : ""
  const meta = `<div class="text-2xs text-fg-3 tabular-nums">${pl.bytes ? fmtBytes(pl.bytes) : ""} · ${fmtMs(pl.latencyMs)}</div>`
  const cors = renderCorsHeaders(pl.headers)
  const raw = pl.raw ? `
    <details class="mt-1">
      <summary class="text-2xs text-fg-3 cursor-pointer hover:text-fg-2">View raw playlist (${pl.raw.length} chars)</summary>
      <pre class="mt-1 text-2xs text-fg-3 font-mono break-all whitespace-pre-wrap max-h-48 overflow-auto custom-scroll">${escapeHtml(pl.raw)}</pre>
    </details>
  ` : ""
  return `<div class="font-medium text-fg">${heading}</div>${top}${td}${total}${meta}${cors}${raw}`
}

function renderFirstSegment(seg) {
  if (!seg) return `<span class="text-fg-3">Skipped (not HLS or no segments).</span>`
  const head = renderHead(seg)
  const dur = seg.declaredDuration
    ? `<div class="text-2xs text-fg-3 tabular-nums">Declared duration: ${seg.declaredDuration.toFixed(2)}s</div>`
    : ""
  const url = `<div class="text-2xs text-fg-3 font-mono break-all">${escapeHtml(seg.url || "")}</div>`
  return `${head}${dur}${url}`
}

function paint(report, opts) {
  const node = ensureDialog()
  if (!node) return

  const titleEl = node.querySelector("[data-role='title']")
  if (titleEl) titleEl.textContent = opts.title || "Stream test"
  const urlEl = node.querySelector("[data-role='url']")
  if (urlEl) urlEl.textContent = report?.url || ""

  const verdictEl = /** @type {HTMLElement | null} */ (
    node.querySelector("[data-role='verdict']")
  )
  if (verdictEl) {
    if (report?.finishedAt) {
      const summary = summarizeReport(report)
      verdictEl.classList.remove("border-line", "border-ok/40", "border-warn/40", "border-bad/40")
      verdictEl.classList.remove("bg-bg", "bg-ok/5", "bg-warn/5", "bg-bad/5")
      let verdictClass = ""
      let verdictText = ""
      if (summary.verdict === "ok") {
        verdictClass = "border-ok/40 bg-ok/5 text-ok"
        verdictText = "Stream is reachable."
      } else if (summary.verdict === "warn") {
        verdictClass = "border-warn/40 bg-warn/5 text-warn"
        verdictText = "Reachable, with caveats."
      } else {
        verdictClass = "border-bad/40 bg-bad/5 text-bad"
        verdictText = "Stream is unreachable."
      }
      verdictEl.className =
        "rounded-xl border px-3 py-2 text-sm flex items-center gap-2 " + verdictClass
      verdictEl.innerHTML = `<span class="font-semibold">${verdictText}</span> <span class="text-fg-2">${escapeHtml(summary.reason || "")}</span>`
    } else {
      verdictEl.className =
        "rounded-xl border border-line bg-bg px-3 py-2 text-sm flex items-center gap-2 text-fg-2"
      verdictEl.innerHTML = `<span class="inline-flex size-2 rounded-full bg-accent animate-pulse"></span> Probing the stream…`
    }
  }

  const reportEl = node.querySelector("[data-role='report']")
  if (reportEl) {
    reportEl.innerHTML = [
      renderStage("Endpoint", renderHead(report?.head)),
      renderStage("HLS playlist", renderPlaylist(report?.playlist)),
      renderStage("First segment", renderFirstSegment(report?.firstSegment)),
    ].join("")
  }
}

/**
 * Open the diagnostic dialog and start probing the URL. Re-running calls
 * diagnoseStream again with the same opts.
 *
 * @param {Object} opts
 * @param {string} opts.url
 * @param {string} [opts.title]
 */
export function openStreamDiagnostic(opts) {
  const node = ensureDialog()
  if (!node) return

  let cancelled = false
  let lastReport = null

  async function run() {
    cancelled = false
    paint({ url: opts.url }, opts)
    const report = await diagnoseStream(opts.url, (partial) => {
      if (cancelled) return
      lastReport = partial
      paint(partial, opts)
    })
    if (cancelled) return
    lastReport = report
    paint(report, opts)
  }

  const copyBtn = /** @type {HTMLButtonElement | null} */ (
    node.querySelector("[data-role='copy']")
  )
  if (copyBtn) {
    copyBtn.onclick = async () => {
      if (!lastReport) return
      try {
        await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2))
        copyBtn.textContent = "Copied"
        setTimeout(() => {
          if (copyBtn) copyBtn.textContent = "Copy report"
        }, 1400)
      } catch (error) {
        console.warn("[xt:diagnostic] copy failed:", error)
      }
    }
  }

  const rerunBtn = /** @type {HTMLButtonElement | null} */ (
    node.querySelector("[data-role='rerun']")
  )
  if (rerunBtn) rerunBtn.onclick = () => run()

  node.addEventListener(
    "close",
    () => {
      cancelled = true
    },
    { once: true }
  )

  if (!node.open) {
    if (typeof node.showModal === "function") node.showModal()
    else node.setAttribute("open", "")
  }

  requestAnimationFrame(() => {
    const target = /** @type {HTMLElement | null} */ (
      node.querySelector("[data-role='close']")
    )
    target?.focus?.({ preventScroll: true })
  })

  run()
}
