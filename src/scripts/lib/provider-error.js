const ICON_ALERT = `<svg viewBox="0 0 24 24" aria-hidden="true" stroke="currentColor" fill="none" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="size-5 text-fg-3 shrink-0"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>`

/**
 * @param {HTMLElement|null} statusEl  The status container to render into.
 * @param {object}   opts
 * @param {string}  [opts.providerName]  Active playlist title; falls back to "the provider".
 * @param {string}  [opts.kind="content"]   "channels" | "movies" | "series" | "EPG" | "content"
 * @param {() => any} opts.onRetry          Re-runs the loader.
 * @param {string}  [opts.detail]           Optional secondary line (e.g. error.message).
 */
export function renderProviderError(statusEl, opts) {
  if (!statusEl) return
  const provider = (opts?.providerName || "").trim() || "the provider"
  const kind = opts?.kind || "content"
  const onRetry = typeof opts?.onRetry === "function" ? opts.onRetry : () => {}

  statusEl.innerHTML = ""
  const wrap = document.createElement("div")
  wrap.setAttribute("role", "alert")
  wrap.setAttribute("aria-live", "polite")
  wrap.className =
    "rounded-xl border border-line bg-surface px-3 py-3 my-1 flex flex-col gap-2 text-sm text-fg-2"

  const row = document.createElement("div")
  row.className = "flex items-start gap-2"
  row.innerHTML = ICON_ALERT
  const msg = document.createElement("div")
  msg.className = "flex-1 min-w-0"
  const head = document.createElement("p")
  head.className = "text-fg leading-snug"
  head.textContent = `Couldn't reach ${provider}.`
  const sub = document.createElement("p")
  sub.className = "text-fg-3 text-xs mt-0.5"
  sub.textContent = `Check your login or try again to load ${kind}.`
  msg.append(head, sub)
  row.appendChild(msg)
  wrap.appendChild(row)

  const actions = document.createElement("div")
  actions.className = "flex items-center gap-2 mt-1"
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className =
    "rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-fg min-h-9 " +
    "hover:bg-surface-2/70 focus-visible:bg-surface-2 focus-visible:border-accent " +
    "focus-visible:outline-none transition-colors"
  btn.textContent = "Retry"
  btn.addEventListener("click", () => {
    btn.disabled = true
    btn.textContent = "Retrying…"
    try {
      Promise.resolve(onRetry()).finally(() => {
        // Caller's loader will re-render the status container, replacing this UI.
        // If it doesn't (e.g. silent success), restore the button so the user can
        // click again.
        if (btn.isConnected) {
          btn.disabled = false
          btn.textContent = "Retry"
        }
      })
    } catch {
      btn.disabled = false
      btn.textContent = "Retry"
    }
  })
  actions.appendChild(btn)
  wrap.appendChild(actions)

  statusEl.appendChild(wrap)
}
