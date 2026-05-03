// Empty state for upstream connection failures.

/**
 * Classify an error response into a structured type with a user-friendly
 * message. Works with HTTP responses, fetch errors, and generic errors.
 *
 * @param {Response|null} [response]
 * @param {Error|string|null} [error]
 * @returns {{ type: string, message: string, hint?: string }}
 */
export function classifyError(response, error) {
  if (response) {
    const status = response.status
    if (status === 0) return { type: "network", message: "Network error — server unreachable." }
    if (status === 401) return { type: "auth", message: "Authentication failed — check your credentials." }
    if (status === 403) return { type: "forbidden", message: "Access denied — your account may be suspended." }
    if (status === 404) return { type: "not_found", message: "Endpoint not found — the provider API may have changed." }
    if (status === 429) return { type: "rate_limited", message: "Too many requests — try again later." }
    if (status >= 500) return { type: "server", message: "Server error — the provider is experiencing issues." }
    return { type: "http", message: `HTTP ${status}: ${response.statusText || "Unknown error"}` }
  }
  if (!error) return { type: "unknown", message: "An unknown error occurred." }
  const msg = String(error)
  // Parse "API 401" or "API 403" style error messages from catalog.js
  const apiMatch = msg.match(/API\s+(\d+)/)
  if (apiMatch) {
    const status = parseInt(apiMatch[1], 10)
    if (status === 401) return { type: "auth", message: "Authentication failed — check your credentials." }
    if (status === 403) return { type: "forbidden", message: "Access denied — your account may be suspended." }
    if (status === 404) return { type: "not_found", message: "Endpoint not found — the provider API may have changed." }
    if (status === 429) return { type: "rate_limited", message: "Too many requests — try again later." }
    if (status >= 500) return { type: "server", message: "Server error — the provider is experiencing issues." }
    return { type: "http", message: `HTTP ${status} — provider returned an unexpected response.` }
  }
  const lower = msg.toLowerCase()
  if (lower.includes("cors") || lower.includes("fetch") || lower.includes("network")) {
    return { type: "cors", message: "CORS blocked — the provider doesn't allow browser requests. Use the desktop app.", hint: "This is a browser security limitation, not a provider issue." }
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { type: "timeout", message: "Request timed out — the server is slow or unreachable." }
  }
  if (lower.includes("abort")) {
    return { type: "aborted", message: "Request was cancelled." }
  }
  return { type: "network", message: `Network error: ${msg}` }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;"
  )
}

const SIGNAL_ART = `
<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <g class="provider-error__waves">
    <path d="M22 56 a 26 26 0 0 1 52 0" class="provider-error__arc provider-error__arc--3"/>
    <path d="M30 56 a 18 18 0 0 1 36 0" class="provider-error__arc provider-error__arc--2"/>
    <path d="M38 56 a 10 10 0 0 1 20 0" class="provider-error__arc provider-error__arc--1"/>
    <circle cx="48" cy="56" r="2.4" fill="currentColor" stroke="none" class="provider-error__dot"/>
  </g>
  <line x1="20" y1="76" x2="76" y2="20" class="provider-error__slash"/>
  <line x1="22" y1="78" x2="78" y2="22" class="provider-error__slash provider-error__slash--accent"/>
</svg>
`

const fmtTime = () => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date())
  } catch {
    return ""
  }
}

const KIND_NOUN = {
  channels: "channel list",
  movies: "movie library",
  series: "series library",
  EPG: "TV schedule",
  content: "library",
}

/**
 * @param {HTMLElement|null} statusEl  The status container to render into.
 * @param {object}   opts
 * @param {string}  [opts.providerName]  Active playlist title; falls back to "this provider".
 * @param {string}  [opts.kind="content"]   "channels" | "movies" | "series" | "EPG" | "content"
 * @param {() => any} opts.onRetry          Re-runs the loader.
 * @param {string}  [opts.detail]           Optional secondary line (e.g. error.message).
 * @param {Response|null} [opts.response]  HTTP response for error classification.
 * @param {Error|string|null} [opts.error]  The caught error object.
 */
export function renderProviderError(statusEl, opts) {
  if (!statusEl) return
  const provider = (opts?.providerName || "").trim() || "this provider"
  const kind = opts?.kind || "content"
  const noun = KIND_NOUN[kind] || KIND_NOUN.content
  const onRetry = typeof opts?.onRetry === "function" ? opts.onRetry : () => {}

  // Classify the error for a more specific message
  const classified = classifyError(opts?.response, opts?.error)
  const detailText = opts?.detail || classified.message

  statusEl.replaceChildren()
  statusEl.classList.add("provider-error-host")

  const wrap = document.createElement("section")
  wrap.setAttribute("role", "alert")
  wrap.setAttribute("aria-live", "polite")
  wrap.className = "provider-error"

  const art = document.createElement("div")
  art.className = "provider-error__art"
  art.innerHTML = SIGNAL_ART
  wrap.appendChild(art)

  const copy = document.createElement("div")
  copy.className = "provider-error__copy"

  const title = document.createElement("h2")
  title.className = "provider-error__title"
  title.textContent = `Can't reach ${provider}`

  const sub = document.createElement("p")
  sub.className = "provider-error__sub"
  sub.textContent = classified.type === "cors"
    ? `We couldn't load the ${noun}. This looks like a CORS issue — the browser is blocking requests to the provider. Try the desktop app.`
    : classified.type === "auth"
    ? `We couldn't load the ${noun}. Your credentials may be invalid or your account may have expired.`
    : classified.type === "server"
    ? `We couldn't load the ${noun}. The provider's server is experiencing issues — this is likely on their end.`
    : `We couldn't load the ${noun}. Your connection, the provider, or your login may be the cause.`

  copy.append(title, sub)
  wrap.appendChild(copy)

  if (detailText) {
    const detail = document.createElement("p")
    detail.className = "provider-error__detail"
    detail.textContent = detailText
    wrap.appendChild(detail)
  }

  if (classified.hint) {
    const hint = document.createElement("p")
    hint.className = "provider-error__meta"
    hint.innerHTML = `<span class="provider-error__meta-dot" style="background: var(--color-accent); opacity: 0.4;" aria-hidden="true"></span>${escapeHtml(classified.hint)}`
    wrap.appendChild(hint)
  }

  const meta = document.createElement("p")
  meta.className = "provider-error__meta"
  const lastTime = fmtTime()
  meta.innerHTML = lastTime
    ? `<span class="provider-error__meta-dot" aria-hidden="true"></span>Last tried at <time>${lastTime}</time>`
    : ""
  wrap.appendChild(meta)

  const actions = document.createElement("div")
  actions.className = "provider-error__actions"

  const retryBtn = document.createElement("button")
  retryBtn.type = "button"
  retryBtn.className = "provider-error__retry"
  retryBtn.innerHTML =
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>` +
    `<span class="provider-error__retry-label">Try again</span>`
  retryBtn.addEventListener("click", () => {
    if (retryBtn.disabled) return
    retryBtn.disabled = true
    wrap.classList.add("provider-error--retrying")
    const label = retryBtn.querySelector(".provider-error__retry-label")
    if (label) label.textContent = "Retrying"
    try {
      Promise.resolve(onRetry()).finally(() => {
        if (retryBtn.isConnected) {
          retryBtn.disabled = false
          wrap.classList.remove("provider-error--retrying")
          if (label) label.textContent = "Try again"
        }
      })
    } catch {
      retryBtn.disabled = false
      wrap.classList.remove("provider-error--retrying")
      if (label) label.textContent = "Try again"
    }
  })

  const settingsLink = document.createElement("a")
  settingsLink.href = "/settings"
  settingsLink.className = "provider-error__settings"
  settingsLink.textContent = "Check playlist settings"

  actions.append(retryBtn, settingsLink)
  wrap.appendChild(actions)

  statusEl.appendChild(wrap)
}
