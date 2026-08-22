// Wakes the receiver app to the foreground when a cast arrives while backgrounded (Android only).
import { log } from "@/scripts/lib/log.js"

interface AndroidReceiverWakeBridge {
  isSupported?: () => boolean
  wake?: () => boolean
}

function bridge(): AndroidReceiverWakeBridge | undefined {
  return (window as unknown as { AndroidReceiverWake?: AndroidReceiverWakeBridge }).AndroidReceiverWake
}

export function receiverWakeAvailable(): boolean {
  try {
    return bridge()?.isSupported?.() === true
  } catch (err) {
    log.warn("[xt:receiver-wake] isSupported failed:", err)
    return false
  }
}

export function wakeReceiverApp(): boolean {
  try {
    return bridge()?.wake?.() === true
  } catch (err) {
    log.warn("[xt:receiver-wake] wake failed:", err)
    return false
  }
}
