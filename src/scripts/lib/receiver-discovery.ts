// Receiver auto-discovery: Android NSD bridge, desktop mDNS via receiver_discover.
import { log } from "@/scripts/lib/log.js"

export interface DiscoveredReceiver {
  name: string
  host: string
  port: number
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)
}

/** Android only; desktop advertising is handled entirely in Rust. */
export function advertiseReceiver(name: string, port: number): void {
  try {
    window.AndroidNsd?.advertise?.(name, port)
  } catch {}
}

export function stopAdvertisingReceiver(): void {
  try {
    window.AndroidNsd?.stopAdvertise?.()
  } catch {}
}

function isDiscoveredReceiver(value: unknown): value is DiscoveredReceiver {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return typeof entry.name === "string" && typeof entry.host === "string" && typeof entry.port === "number"
}

function parseDiscovered(json: string): DiscoveredReceiver[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter(isDiscoveredReceiver) : []
  } catch {
    return []
  }
}

function hostPortKey(receiver: DiscoveredReceiver): string {
  return `${receiver.host}:${receiver.port}`
}

/** Starts discovery, returns a cancel function. Android polls AndroidNsd; desktop probes mDNS once via Rust. */
export function discoverReceivers(
  onFound: (list: DiscoveredReceiver[]) => void,
  timeoutMs = 3000
): () => void {
  let cancelled = false

  if (typeof window !== "undefined" && window.AndroidNsd?.isSupported?.()) {
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
        const key = hostPortKey(receiver)
        if (!found.has(key)) changed = true
        found.set(key, receiver)
      }
      if (changed) onFound([...found.values()])
    }, 700)

    const stopTimer = setTimeout(() => {
      clearInterval(poll)
      stopDiscovery()
    }, timeoutMs)

    return () => {
      cancelled = true
      clearInterval(poll)
      clearTimeout(stopTimer)
      stopDiscovery()
    }
  }

  if (isTauriRuntime()) {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        const result = await invoke<DiscoveredReceiver[]>("receiver_discover", { timeoutMs })
        if (!cancelled) onFound(result)
      } catch (err) {
        log.warn("[xt:receiver-discovery] receiver_discover failed:", err)
      }
    })()
    return () => {
      cancelled = true
    }
  }

  return () => {
    cancelled = true
  }
}
