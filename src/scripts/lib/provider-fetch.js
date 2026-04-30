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
        console.error(
          "[xt:net] plugin-http unavailable, falling back to native fetch:",
          e
        )
        return null
      })
  }
  return tauriFetchPromise
}

export async function providerFetch(url, init = {}) {
  const ua = getUserAgent()
  const tauriFetch = await getTauriFetch()
  if (tauriFetch) {
    const headers = new Headers(init.headers || {})
    if (ua) headers.set("User-Agent", ua)
    try {
      return await tauriFetch(url, { ...init, headers })
    } catch (e) {
      const tag = init?.signal?.aborted ? "aborted" : "failed"
      if (tag !== "aborted") {
        console.error("[xt:net] tauri fetch failed", { url, error: e })
      }
      throw e
    }
  }
  try {
    return await fetch(url, init)
  } catch (e) {
    if (!init?.signal?.aborted) {
      console.error("[xt:net] native fetch failed", { url, error: e })
    }
    throw e
  }
}
