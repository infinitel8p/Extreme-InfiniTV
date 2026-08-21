// Android foreground service keep-alive, shared by every receiver-server start/stop site.
import { log } from "@/scripts/lib/log.js"

let startedName: string | null = null

export function startReceiverKeepAlive(deviceName: string): void {
  if (startedName === deviceName) return
  try {
    window.AndroidReceiverKeepAlive?.start?.(deviceName)
    startedName = deviceName
  } catch (err) {
    log.warn("[xt:receiver-keep-alive] start failed:", err)
  }
}

export function stopReceiverKeepAlive(): void {
  if (startedName === null) return
  try {
    window.AndroidReceiverKeepAlive?.stop?.()
  } catch (err) {
    log.warn("[xt:receiver-keep-alive] stop failed:", err)
  } finally {
    startedName = null
  }
}
