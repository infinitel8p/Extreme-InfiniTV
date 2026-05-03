import { t } from "@/scripts/lib/i18n.js"

const SIGNAL_ART = `
<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M48 64v8" />
  <path d="M40 78l8 -6 8 6" opacity=".55" />
  <path d="M40 50a12 12 0 0 1 16 0" opacity=".7" />
  <path d="M32 42a24 24 0 0 1 32 0" opacity=".5" />
  <path d="M24 34a36 36 0 0 1 48 0" opacity=".3" />
</svg>
`

function fmtTime(d = new Date()) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(d)
  } catch {
    return ""
  }
}

const KIND_KEY = {
  channels: "providerError.kind.channels",
  movies: "providerError.kind.movies",
  series: "providerError.kind.series",
  EPG: "providerError.kind.epg",
  content: "providerError.kind.content",
}

/**
 * @param {HTMLElement|null} statusEl  The status container to render into.
 * @param {object}   opts
 * @param {string}  [opts.providerName]  Active playlist title; falls back to "this provider".
 * @param {string}  [opts.kind="content"]   "channels" | "movies" | "series" | "EPG" | "content"
 * @param {() => any} opts.onRetry          Re-runs the loader.
 * @param {string}  [opts.detail]           Optional secondary line (e.g. error.message).
 */
export function renderProviderError(statusEl, opts) {
  if (!statusEl) return
  const provider = (opts?.providerName || "").trim() || t("providerError.fallback")
  const kind = opts?.kind || "content"
  const noun = t(KIND_KEY[kind] || KIND_KEY.content)
  const onRetry = typeof opts?.onRetry === "function" ? opts.onRetry : () => {}

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
  title.textContent = t("providerError.title", { provider })

  const sub = document.createElement("p")
  sub.className = "provider-error__sub"
  sub.textContent = t("providerError.sub", { noun })

  copy.append(title, sub)
  wrap.appendChild(copy)

  if (opts?.detail) {
    const detail = document.createElement("p")
    detail.className = "provider-error__detail"
    detail.textContent = String(opts.detail)
    wrap.appendChild(detail)
  }

  const meta = document.createElement("p")
  meta.className = "provider-error__meta"
  const lastTime = fmtTime()
  meta.innerHTML = lastTime
    ? `<span class="provider-error__meta-dot" aria-hidden="true"></span>${t("providerError.lastTried")} <time>${lastTime}</time>`
    : ""
  wrap.appendChild(meta)

  const actions = document.createElement("div")
  actions.className = "provider-error__actions"

  const retryBtn = document.createElement("button")
  retryBtn.type = "button"
  retryBtn.className = "provider-error__retry"
  retryBtn.innerHTML =
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>` +
    `<span class="provider-error__retry-label">${t("providerError.tryAgain")}</span>`
  retryBtn.addEventListener("click", () => {
    if (retryBtn.disabled) return
    retryBtn.disabled = true
    wrap.classList.add("provider-error--retrying")
    const label = retryBtn.querySelector(".provider-error__retry-label")
    if (label) label.textContent = t("providerError.retrying")
    try {
      Promise.resolve(onRetry()).finally(() => {
        if (retryBtn.isConnected) {
          retryBtn.disabled = false
          wrap.classList.remove("provider-error--retrying")
          if (label) label.textContent = t("providerError.tryAgain")
        }
      })
    } catch {
      retryBtn.disabled = false
      wrap.classList.remove("provider-error--retrying")
      if (label) label.textContent = t("providerError.tryAgain")
    }
  })

  const settingsLink = document.createElement("a")
  settingsLink.href = "/settings"
  settingsLink.className = "provider-error__settings"
  settingsLink.textContent = t("providerError.checkSettings")

  actions.append(retryBtn, settingsLink)
  wrap.appendChild(actions)

  statusEl.appendChild(wrap)
}
