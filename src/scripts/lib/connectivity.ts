// Online/offline awareness. Mounted from Layout.astro.
// Shows a sticky toast when the WebView reports offline, dismisses it on
// reconnect, and dispatches xt:reconnected so EPG / catalog can opt to
// refresh in the background.

import { toast } from "@/scripts/lib/toast.js"
import { t } from "@/scripts/lib/i18n.js"

export const RECONNECT_EVENT = "xt:reconnected"

let dismissOfflineToast: (() => void) | null = null

function showOfflineToast() {
  if (dismissOfflineToast) return
  dismissOfflineToast = toast({
    title: t("stream.offline.title"),
    description: t("stream.offline.body"),
    variant: "warn",
    duration: 0,
  })
}

function clearOfflineToast() {
  if (!dismissOfflineToast) return
  try { dismissOfflineToast() } catch {}
  dismissOfflineToast = null
}

let initialized = false

export function initConnectivity() {
  if (initialized || typeof window === "undefined") return
  initialized = true
  if (navigator.onLine === false) showOfflineToast()
  window.addEventListener("offline", showOfflineToast)
  window.addEventListener("online", async () => {
    clearOfflineToast()
    try {
      document.dispatchEvent(new CustomEvent(RECONNECT_EVENT))
    } catch {}
    try {
      const { warmupActive } = await import("@/scripts/lib/catalog.js")
      warmupActive().catch(() => {})
    } catch {}
  })
}
