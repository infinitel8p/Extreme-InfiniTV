// Per-isolate fixed-window limiter; a WAF rule is the global control.
const WINDOW_MS = 60_000
const MAX_REQUESTS_PER_WINDOW = 120
const MAX_TRACKED_CLIENTS = 5_000

interface Window {
  count: number
  resetAt: number
}

const windows = new Map<string, Window>()

// Drop finished windows before resorting to a wipe, so one flood cannot clear
// every honest client counter.
function sweepExpired(nowMs: number): void {
  for (const [client, window] of windows) {
    if (nowMs >= window.resetAt) windows.delete(client)
  }
  if (windows.size >= MAX_TRACKED_CLIENTS) windows.clear()
}

export function rateLimitExceeded(clientIp: string, nowMs: number): boolean {
  if (!clientIp) return false
  const existing = windows.get(clientIp)
  if (!existing || nowMs >= existing.resetAt) {
    if (windows.size >= MAX_TRACKED_CLIENTS) sweepExpired(nowMs)
    windows.set(clientIp, { count: 1, resetAt: nowMs + WINDOW_MS })
    return false
  }
  existing.count += 1
  return existing.count > MAX_REQUESTS_PER_WINDOW
}

export function retryAfterSeconds(clientIp: string, nowMs: number): number {
  const existing = windows.get(clientIp)
  if (!existing) return 1
  return Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000))
}

export function resetRateLimits(): void {
  windows.clear()
}
