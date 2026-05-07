import { log } from "@/scripts/lib/log.js"
import { getUserAgent } from "@/scripts/lib/app-settings.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)

let tauriFetchPromise = null
async function getTauriFetch() {
  if (!isTauri) return null
  if (!tauriFetchPromise) {
    tauriFetchPromise = import("@tauri-apps/plugin-http")
      .then((m) => m.fetch)
      .catch((e) => {
        log.error("[xt:net] plugin-http unavailable:", e)
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

const DEFAULT_TIMEOUT_MS = 20_000

// Lightweight provider-fetch statistics
const _stats = {
  lastSuccessAt: 0,
  lastFailureAt: 0,
  lastError: "",
  successes: 0,
  failures: 0,
  lastStatus: 0,
}

function noteSuccess(status) {
  _stats.lastSuccessAt = Date.now()
  _stats.lastStatus = status || 0
  _stats.successes++
}

function noteFailure(error) {
  _stats.lastFailureAt = Date.now()
  _stats.lastError = String(error?.message || error || "").slice(0, 200)
  _stats.failures++
}

export function getProviderStats() {
  return { ..._stats }
}

export async function providerFetch(url, init = {}) {
  const ua = getUserAgent()
  const u = String(url).slice(0, 200)

  const callerSignal = init.signal
  const callInit = callerSignal
    ? init
    : { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) }

  if (!ua || !isTauri) {
    log.log(`[xt:net] native start`, u)
    try {
      const r = await nativeFetch(url, callInit, u, callerSignal)
      noteSuccess(r.status)
      return r
    } catch (e) {
      if (!callerSignal?.aborted) noteFailure(e)
      throw e
    }
  }

  const tauriFetch = await getTauriFetch()
  if (!tauriFetch) {
    log.log(`[xt:net] native start (no plugin-http)`, u)
    try {
      const r = await nativeFetch(url, callInit, u, callerSignal)
      noteSuccess(r.status)
      return r
    } catch (e) {
      if (!callerSignal?.aborted) noteFailure(e)
      throw e
    }
  }

  log.log(`[xt:net] tauri start ua=${ua}`, u)
  const headers = new Headers(callInit.headers || {})
  headers.set("User-Agent", ua)
  try {
    const r = await tauriFetch(url, { ...callInit, headers })
    log.log(`[xt:net] tauri ok ${r.status}`, u)
    noteSuccess(r.status)
    return r
  } catch (e) {
    if (callerSignal?.aborted) throw e
    log.warn(
      "[xt:net] tauri fetch failed, falling back to native:",
      String(e?.message || e)
    )
    try {
      const r = await nativeFetch(url, callInit, u, callerSignal)
      noteSuccess(r.status)
      return r
    } catch (e2) {
      if (!callerSignal?.aborted) noteFailure(e2)
      throw e2
    }
  }
}
