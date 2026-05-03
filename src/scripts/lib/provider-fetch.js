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

async function nativeFetch(url, init, u) {
  try {
    const r = await fetch(url, init)
    log.log(`[xt:net] native ok ${r.status}`, u)
    return r
  } catch (e) {
    if (!init?.signal?.aborted) {
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

export async function providerFetch(url, init = {}) {
  const ua = getUserAgent()
  const u = String(url).slice(0, 200)

  if (!ua || !isTauri) {
    log.log(`[xt:net] native start`, u)
    return await nativeFetch(url, init, u)
  }

  const tauriFetch = await getTauriFetch()
  if (!tauriFetch) {
    log.log(`[xt:net] native start (no plugin-http)`, u)
    return await nativeFetch(url, init, u)
  }

  log.log(`[xt:net] tauri start ua=${ua}`, u)
  const headers = new Headers(init.headers || {})
  headers.set("User-Agent", ua)
  try {
    const r = await tauriFetch(url, { ...init, headers })
    log.log(`[xt:net] tauri ok ${r.status}`, u)
    return r
  } catch (e) {
    if (init?.signal?.aborted) throw e
    log.warn(
      "[xt:net] tauri fetch failed, falling back to native:",
      String(e?.message || e)
    )
    return await nativeFetch(url, init, u)
  }
}
