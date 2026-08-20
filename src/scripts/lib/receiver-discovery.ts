// Receiver auto-discovery: Android NSD bridge, desktop mDNS via receiver_discover.
import { log } from "@/scripts/lib/log.js"

export interface DiscoveredReceiver {
  name: string
  host: string
  port: number
  id?: string
  hosts: string[]
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)
}

/** Android only; desktop advertising is handled entirely in Rust. */
export function advertiseReceiver(name: string, port: number, id?: string): void {
  try {
    window.AndroidNsd?.advertise?.(name, port, id ?? "")
  } catch {}
  if (typeof window === "undefined" || !window.AndroidNsd) return
  setTimeout(() => {
    const state = getAdvertiseState()
    if (state === "registered") {
      log.info(`[xt:receiver-discovery] advertise registered as ${name}`)
    } else if (state?.startsWith("failed")) {
      log.error(`[xt:receiver-discovery] advertise failed, state=${state}`)
    }
  }, 1500)
}

export function stopAdvertisingReceiver(): void {
  try {
    window.AndroidNsd?.stopAdvertise?.()
  } catch {}
}

/** Android only; last known outcome of `advertiseReceiver`, null when the bridge is unavailable. */
export function getAdvertiseState(): string | null {
  try {
    return window.AndroidNsd?.advertiseState?.() ?? null
  } catch {
    return null
  }
}

function isDiscoveredReceiver(value: unknown): value is DiscoveredReceiver {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  if (typeof entry.name !== "string" || typeof entry.host !== "string" || typeof entry.port !== "number") return false
  if (entry.id !== undefined && typeof entry.id !== "string") return false
  if (entry.hosts !== undefined && (!Array.isArray(entry.hosts) || entry.hosts.some((host) => typeof host !== "string"))) {
    return false
  }
  return true
}

/** Normalizes a raw discovered entry so `hosts` is always populated (older sources send `host` only). */
function normalizeDiscovered(receiver: DiscoveredReceiver): DiscoveredReceiver {
  return receiver.hosts?.length ? receiver : { ...receiver, hosts: [receiver.host] }
}

function parseDiscovered(json: string): DiscoveredReceiver[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter(isDiscoveredReceiver).map(normalizeDiscovered) : []
  } catch {
    return []
  }
}

/** Merges by mDNS id when present, else host:port; used to dedupe repeat discovery events. */
function identityKey(receiver: DiscoveredReceiver): string {
  return receiver.id ? `id:${receiver.id}` : `${receiver.host}:${receiver.port}`
}

/** Starts discovery, returns a cancel function. Android polls AndroidNsd; desktop probes mDNS once via Rust. */
export function discoverReceivers(
  onFound: (list: DiscoveredReceiver[]) => void,
  timeoutMs = 3000,
  onDone?: (errorMessage: string | null) => void
): () => void {
  let cancelled = false

  if (typeof window !== "undefined" && window.AndroidNsd?.isSupported?.()) {
    log.info(`[xt:receiver-discovery] scanning via android-nsd, timeout=${timeoutMs}ms`)
    const found = new Map<string, DiscoveredReceiver>()
    try {
      window.AndroidNsd.startDiscovery?.()
    } catch {}

    const stopDiscovery = () => {
      try {
        window.AndroidNsd?.stopDiscovery?.()
      } catch {}
    }

    const poll = setInterval(() => {
      if (cancelled) return
      const drained = parseDiscovered(window.AndroidNsd?.drainDiscovered?.() ?? "[]")
      let changed = false
      for (const receiver of drained) {
        const key = identityKey(receiver)
        if (!found.has(key)) changed = true
        found.set(key, receiver)
      }
      if (changed) onFound([...found.values()])
    }, 700)

    const stopTimer = setTimeout(() => {
      clearInterval(poll)
      stopDiscovery()
      log.info(`[xt:receiver-discovery] scan complete, found=${found.size}`)
      onDone?.(null)
    }, timeoutMs)

    return () => {
      cancelled = true
      clearInterval(poll)
      clearTimeout(stopTimer)
      stopDiscovery()
    }
  }

  if (isTauriRuntime()) {
    log.info(`[xt:receiver-discovery] scanning via tauri, timeout=${timeoutMs}ms`)
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        const result = await invoke<DiscoveredReceiver[]>("receiver_discover", { timeoutMs })
        if (cancelled) return
        onFound(result)
        log.info(`[xt:receiver-discovery] scan complete, found=${result.length}`)
        onDone?.(null)
      } catch (err) {
        log.warn("[xt:receiver-discovery] receiver_discover failed:", err)
        if (!cancelled) onDone?.(String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }

  onDone?.(null)
  return () => {
    cancelled = true
  }
}
