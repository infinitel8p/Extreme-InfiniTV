// Streams the TV receiver's own log over the /events WebSocket to whoever is casting to it.
import { addLogSink } from "@/scripts/lib/log"

// Batched: a fast-retrying failure would otherwise cost an IPC round trip per line.
const FLUSH_DELAY_MS = 400
const MAX_PENDING_LINES = 64

let pending: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let detachSink: (() => void) | null = null
let flushInFlight = false

function isTauri(): boolean {
    return typeof window !== "undefined" && (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)
}

/** Pure: shapes one sink call into the line the sender will display. */
export function formatLogLine(level: "error" | "warn" | "info", text: string, at: Date): string {
    const stamp = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}:${String(
        at.getSeconds()
    ).padStart(2, "0")}`
    return `[${stamp}][${level.toUpperCase()}] ${text}`
}

async function flush(): Promise<void> {
    flushTimer = null
    if (flushInFlight || pending.length === 0) return
    const lines = pending
    pending = []
    flushInFlight = true
    try {
        const { invoke } = await import("@tauri-apps/api/core")
        await invoke("receiver_log_lines", { lines })
    } catch {
        // Never re-queue and never log: a failed flush that logs would feed the sink it came from.
    } finally {
        flushInFlight = false
        // Anything that arrived while the invoke was in flight still needs a flush scheduled.
        if (pending.length > 0 && !flushTimer) flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS)
    }
}

/** Starts mirroring this page's log to the cast sender; idempotent, no-op off Tauri, returns a stop function. */
export function startReceiverLogStream(): () => void {
    if (detachSink || !isTauri()) return () => {}
    detachSink = addLogSink((level, text) => {
        if (pending.length >= MAX_PENDING_LINES) pending.shift()
        pending.push(formatLogLine(level, text, new Date()))
        if (!flushTimer) flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS)
    })
    return stopReceiverLogStream
}

export function stopReceiverLogStream(): void {
    detachSink?.()
    detachSink = null
    if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
    }
    pending = []
}
