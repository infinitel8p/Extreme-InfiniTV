import { log, redactUrl } from "@/scripts/lib/log.js"
import {
  getUserAgent,
  getNetworkTimeoutSeconds,
} from "@/scripts/lib/app-settings.js"
import { splitUrlAuth } from "@/scripts/lib/url-auth"
import { recordNetLog } from "@/scripts/lib/net-log"

const isTauri =
  typeof window !== "undefined" &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)

export const DEFAULT_BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

let tauriFetchPromise = null
async function getTauriFetch() {
  if (!isTauri) return null
  if (!tauriFetchPromise) {
    tauriFetchPromise = import("@tauri-apps/plugin-http")
      .then((m) => m.fetch)
      .catch((e) => {
        log.error("[xt:net] plugin-http unavailable:", e)
        tauriFetchPromise = null
        return null
      })
  }
  return tauriFetchPromise
}

async function nativeFetch(url, init, u, callerSignal) {
  try {
    const r = await fetch(url, init)
    log.log(`[xt:net] native ok ${r.status}`, u)
    return r
  } catch (e) {
    if (!callerSignal?.aborted) {
      log.error("[xt:net] native fetch failed", { url: u, error: e })
    }
    throw e
  }
}

/**
 * Drain a Response body to text, calling onProgress(received, total) as
 * bytes accumulate. `total` comes from the Content-Length header (0 if
 * the server didn't send one - chunked encoding etc.). If the body isn't
 * a readable stream (some Tauri http plugin builds buffer eagerly), we
 * fall back to response.text() with a single final progress callback.
 *
 * @param {Response} response
 * @param {(received: number, total: number) => void} [onProgress]
 * @returns {Promise<string>}
 */
export async function streamingText(response, onProgress) {
  const total = Number(response.headers?.get?.("content-length")) || 0
  const body = response.body
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text()
    if (onProgress) {
      try { onProgress(text.length, total) } catch {}
    }
    return text
  }
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8")
  let received = 0
  let result = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength) {
        received += value.byteLength
        result += decoder.decode(value, { stream: true })
        if (onProgress) {
          try { onProgress(received, total) } catch {}
        }
      }
    }
    result += decoder.decode()
  } finally {
    try { reader.releaseLock() } catch {}
  }
  return result
}

function defaultTimeoutMs() {
  return getNetworkTimeoutSeconds() * 1000
}

// Lightweight provider-fetch statistics
const _stats = {
  lastSuccessAt: 0,
  lastFailureAt: 0,
  lastError: "",
  successes: 0,
  failures: 0,
  lastStatus: 0,
}

function noteSuccess(status, context) {
  _stats.lastSuccessAt = Date.now()
  _stats.lastStatus = status || 0
  _stats.successes++
  recordNetLog({ ...context, endedAt: Date.now(), status })
}

function noteFailure(error, context) {
  _stats.lastFailureAt = Date.now()
  _stats.lastError = String(error?.message || error || "").slice(0, 200)
  _stats.failures++
  recordNetLog({ ...context, endedAt: Date.now(), error })
}

function noteAborted(context) {
  recordNetLog({ ...context, endedAt: Date.now(), outcome: "aborted" })
}

export function getProviderStats() {
  return { ..._stats }
}

export async function providerFetch(url, init = {}) {
  // fetch() rejects URLs with embedded credentials; move them to a header.
  const { url: requestUrl, authorization } = splitUrlAuth(String(url))
  const ua = getUserAgent()
  const u = redactUrl(requestUrl).slice(0, 200)
  const context = {
    method: String(init.method || "GET"),
    url: u,
    kind: init.logKind || "other",
    startedAt: Date.now(),
    transport: isTauri ? "tauri" : "native",
  }

  const callerSignal = init.signal
  const callInit = { ...init }
  // Still accepted for back-compat (callers pass it); no longer changes
  // routing now that Tauri requests always send a browser UA by default.
  delete callInit.forceTauri
  delete callInit.logKind
  if (authorization) {
    const mergedHeaders = new Headers(callInit.headers || {})
    if (!mergedHeaders.has("Authorization")) {
      mergedHeaders.set("Authorization", authorization)
    }
    callInit.headers = mergedHeaders
  }
  if (!callerSignal) {
    const timeoutMs = defaultTimeoutMs()
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      callInit.signal = AbortSignal.timeout(timeoutMs)
    } else if (typeof AbortController !== "undefined") {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), timeoutMs)
      callInit.signal = controller.signal
    }
  }

  const useTauri = isTauri

  if (!useTauri) {
    log.log(`[xt:net] native start`, u)
    try {
      const r = await nativeFetch(requestUrl, callInit, u, callerSignal)
      noteSuccess(r.status, context)
      return r
    } catch (e) {
      if (!callerSignal?.aborted) noteFailure(e, context)
      else noteAborted(context)
      throw e
    }
  }

  const tauriFetch = await getTauriFetch()
  if (!tauriFetch) {
    log.log(`[xt:net] native start (no plugin-http)`, u)
    try {
      const r = await nativeFetch(requestUrl, callInit, u, callerSignal)
      noteSuccess(r.status, context)
      return r
    } catch (e) {
      if (!callerSignal?.aborted) noteFailure(e, context)
      else noteAborted(context)
      throw e
    }
  }

  log.log(`[xt:net] tauri start ua=${ua || "(default browser)"}`, u)
  const headers = new Headers(callInit.headers || {})
  // Always send a UA: the custom one if set, otherwise a browser UA so the
  // reqwest default ("reqwest/x.y") never reaches providers that block it.
  headers.set("User-Agent", ua || DEFAULT_BROWSER_UA)
  try {
    const r = await tauriFetch(requestUrl, { ...callInit, headers })
    log.log(`[xt:net] tauri ok ${r.status}`, u)
    noteSuccess(r.status, context)
    return r
  } catch (e) {
    if (callerSignal?.aborted) {
      noteAborted(context)
      throw e
    }
    context.transport = "tauri-fallback"
    log.warn(
      "[xt:net] tauri fetch failed, falling back to native:",
      String(e?.message || e)
    )
    try {
      const r = await nativeFetch(requestUrl, callInit, u, callerSignal)
      noteSuccess(r.status, context)
      return r
    } catch (e2) {
      if (!callerSignal?.aborted) noteFailure(e2, context)
      else noteAborted(context)
      throw e2
    }
  }
}
