import { log, redactUrl } from "@/scripts/lib/log.js"
import {
  getUserAgent,
  getNetworkTimeoutSeconds,
  getGlobalDns,
} from "@/scripts/lib/app-settings.js"
import { splitUrlAuth } from "@/scripts/lib/url-auth"
import { recordNetLog } from "@/scripts/lib/net-log"
import { dnsProxyAvailable, ensureDnsProxy } from "@/scripts/lib/dns-proxy.ts"
import { wrapProxyUrl } from "@/scripts/lib/dns-proxy-url.ts"
import { describeDnsServer, parseDnsServer } from "@/scripts/lib/dns-config.ts"
// Safe as a static import: creds.js only reaches back to us dynamically.
import { getActiveDnsOverrideAsync } from "@/scripts/lib/creds.js"

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

// tauri-plugin-http reports an abort as a plain Error, without the name retry.ts and
// provider-error.js key on, so an abort would read as a network fault on the desktop transport.
const PLUGIN_ABORT_MESSAGES = [/request canceled/i, /resource id \d+ is invalid/i]

export function isAbortLikeError(error, signal) {
  if (!error) return false
  const name = error.name || ""
  if (name === "AbortError" || name === "TimeoutError") return true
  if (!signal?.aborted) return false
  const message = String(error.message || error)
  return PLUGIN_ABORT_MESSAGES.some((pattern) => pattern.test(message))
}

function timeoutReason() {
  if (typeof DOMException === "undefined") return new Error("The operation timed out.")
  return new DOMException("The operation timed out.", "TimeoutError")
}

// plugin-http cancels the Rust body from its own abort listener without catching the invoke, so our
// request timeout firing after a drained body rejects for a resource id Rust had already freed.
const PLUGIN_FREED_RESOURCE = /^the resource id \d+ is invalid\.?$/i

export function isPluginCleanupNoise(reason) {
  const message = typeof reason === "string" ? reason : String(reason?.message ?? "")
  return PLUGIN_FREED_RESOURCE.test(message.trim())
}

let cleanupNoiseFilterInstalled = false
function installCleanupNoiseFilter() {
  if (cleanupNoiseFilterInstalled || !isTauri || typeof window === "undefined") return
  cleanupNoiseFilterInstalled = true
  window.addEventListener("unhandledrejection", (event) => {
    if (!isPluginCleanupNoise(event.reason)) return
    event.preventDefault()
    log.log("[xt:net] ignored plugin-http cleanup rejection:", String(event.reason?.message || event.reason))
  })
}
installCleanupNoiseFilter()

function asAbortError(error, signal) {
  if (typeof DOMException === "undefined") return error
  if (error instanceof DOMException) return error
  const timedOut = signal?.reason?.name === "TimeoutError"
  return new DOMException(
    timedOut ? "The operation timed out." : "The operation was aborted.",
    timedOut ? "TimeoutError" : "AbortError"
  )
}

async function nativeFetch(url, init, u, abortSignal) {
  try {
    const r = await fetch(url, init)
    log.log(`[xt:net] native ok ${r.status}`, u)
    return r
  } catch (e) {
    if (!abortSignal?.aborted) {
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

/**
 * Same streaming contract as `streamingText`, but accumulates raw bytes and returns
 * an exact-length transferable ArrayBuffer instead of decoding to a string - lets a
 * caller hand the body straight to a Worker without a multi-MB string ever existing
 * on the main thread.
 *
 * @param {Response} response
 * @param {(received: number, total: number) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function streamingBytes(response, onProgress) {
  const total = Number(response.headers?.get?.("content-length")) || 0
  const body = response.body
  if (!body || typeof body.getReader !== "function") {
    const buffer = await response.arrayBuffer()
    if (onProgress) {
      try { onProgress(buffer.byteLength, total) } catch {}
    }
    return buffer
  }
  const reader = body.getReader()
  const chunks = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength) {
        received += value.byteLength
        chunks.push(value)
        if (onProgress) {
          try { onProgress(received, total) } catch {}
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged.buffer
}

function defaultTimeoutMs() {
  return getNetworkTimeoutSeconds() * 1000
}

// DNS-proxy-wrapped URL for a request; falls back to the original on any failure.
// explicitServer: undefined -> the active playlist's override, "global" -> the global default
// (for app-level endpoints that belong to no playlist), null -> direct, a DnsServer -> that server.
export async function resolveDnsRoutedUrl(requestUrl, explicitServer) {
  if (!dnsProxyAvailable()) return { url: requestUrl, server: null }
  let server = explicitServer
  if (server === "global") {
    server = parseDnsServer(getGlobalDns())
  } else if (server === undefined) {
    try {
      server = await getActiveDnsOverrideAsync()
    } catch (e) {
      log.warn("[xt:net] getActiveDnsOverrideAsync failed:", e)
      server = null
    }
  }
  if (!server) return { url: requestUrl, server: null }
  const sessionKey = `dns:${server.raw}`
  const base = await ensureDnsProxy(sessionKey, server)
  if (!base) return { url: requestUrl, server: null }
  try {
    return { url: wrapProxyUrl(base, requestUrl), server }
  } catch (e) {
    log.warn("[xt:net] dns-proxy wrap failed:", e)
    return { url: requestUrl, server: null }
  }
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
  // The net log always shows the real (unwrapped) URL, never the DNS-proxy loopback form.
  const u = redactUrl(requestUrl).slice(0, 200)
  const { url: effectiveUrl, server: dnsServer } = await resolveDnsRoutedUrl(requestUrl, init.dns)
  const context = {
    method: String(init.method || "GET"),
    url: u,
    kind: init.logKind || "other",
    startedAt: Date.now(),
    transport: isTauri ? "tauri" : "native",
    ...(dnsServer ? { dns: describeDnsServer(dnsServer) } : {}),
  }

  const callerSignal = init.signal
  const callInit = { ...init }
  // Still accepted for back-compat (callers pass it); no longer changes
  // routing now that Tauri requests always send a browser UA by default.
  delete callInit.forceTauri
  delete callInit.logKind
  delete callInit.dns
  if (authorization) {
    const mergedHeaders = new Headers(callInit.headers || {})
    if (!mergedHeaders.has("Authorization")) {
      mergedHeaders.set("Authorization", authorization)
    }
    callInit.headers = mergedHeaders
  }
  // Cached catalog/EPG bodies outlive the session, so only media may be rewritten to loopback URLs.
  if (dnsServer && context.kind !== "media") {
    const mergedHeaders = new Headers(callInit.headers || {})
    mergedHeaders.set("x-xt-dns-raw", "1")
    callInit.headers = mergedHeaders
  }
  if (!callerSignal) {
    const timeoutMs = defaultTimeoutMs()
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      callInit.signal = AbortSignal.timeout(timeoutMs)
    } else if (typeof AbortController !== "undefined") {
      const controller = new AbortController()
      // Reason must name the timeout, so this path classifies like AbortSignal.timeout's does.
      setTimeout(() => controller.abort(timeoutReason()), timeoutMs)
      callInit.signal = controller.signal
    }
  }
  // Our own timeout aborts as hard as the caller's; every abort check below must see both.
  const abortSignal = callerSignal || callInit.signal

  const useTauri = isTauri

  if (!useTauri) {
    log.log(`[xt:net] native start`, u)
    try {
      const r = await nativeFetch(effectiveUrl, callInit, u, abortSignal)
      noteSuccess(r.status, context)
      return r
    } catch (e) {
      if (isAbortLikeError(e, abortSignal)) {
        noteAborted(context)
        throw asAbortError(e, abortSignal)
      }
      noteFailure(e, context)
      throw e
    }
  }

  const tauriFetch = await getTauriFetch()
  if (!tauriFetch) {
    log.log(`[xt:net] native start (no plugin-http)`, u)
    try {
      const r = await nativeFetch(effectiveUrl, callInit, u, abortSignal)
      noteSuccess(r.status, context)
      return r
    } catch (e) {
      if (isAbortLikeError(e, abortSignal)) {
        noteAborted(context)
        throw asAbortError(e, abortSignal)
      }
      noteFailure(e, context)
      throw e
    }
  }

  log.log(`[xt:net] tauri start ua=${ua || "(default browser)"}`, u)
  const headers = new Headers(callInit.headers || {})
  // Always send a UA: the custom one if set, otherwise a browser UA so the
  // reqwest default ("reqwest/x.y") never reaches providers that block it.
  headers.set("User-Agent", ua || DEFAULT_BROWSER_UA)
  try {
    const r = await tauriFetch(effectiveUrl, { ...callInit, headers })
    log.log(`[xt:net] tauri ok ${r.status}`, u)
    noteSuccess(r.status, context)
    return r
  } catch (e) {
    // An abort is final: a native retry on an already-dead signal cannot succeed.
    if (isAbortLikeError(e, abortSignal)) {
      noteAborted(context)
      throw asAbortError(e, abortSignal)
    }
    context.transport = "tauri-fallback"
    log.warn(
      "[xt:net] tauri fetch failed, falling back to native:",
      String(e?.message || e)
    )
    try {
      const r = await nativeFetch(effectiveUrl, callInit, u, abortSignal)
      noteSuccess(r.status, context)
      return r
    } catch (e2) {
      if (isAbortLikeError(e2, abortSignal)) {
        noteAborted(context)
        throw asAbortError(e2, abortSignal)
      }
      noteFailure(e2, context)
      throw e2
    }
  }
}
