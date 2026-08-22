// Tries to bring the receiver app forward when a cast arrives while backgrounded (Android only).
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

// True only when the app really came forward: Android 10+ can only post a tap-to-open notification.
export function wakeReceiverApp(): boolean {
  try {
    return bridge()?.wake?.() === true
  } catch (err) {
    log.warn("[xt:receiver-wake] wake failed:", err)
    return false
  }
}
