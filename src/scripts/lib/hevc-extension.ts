// On-demand install of Microsoft's HEVC Video Extension so WebView2 can decode
// HEVC (DASH/HLS) in-app. Windows desktop only. The Store/MSIX build can't
// Add-AppxPackage from its sandbox, so it deep-links to the Store instead.

import { invoke } from "@tauri-apps/api/core"
import { confirmDialog } from "@/scripts/lib/confirm-dialog"
import { toast, toastError } from "@/scripts/lib/toast"
import { deviceSupportsHevc } from "@/scripts/lib/codec-hints"
import { openExternal } from "@/scripts/lib/external-link"
import { t } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const APPX_URL =
  "https://github.com/infinitel8p/Extreme-InfiniTV/releases/download/hevc-extension/Microsoft.HEVCVideoExtension_2.0.61931.0_neutral_._8wekyb3d8bbwe.AppxBundle"
const APPX_SHA256 = "fbcfbc9ed5c1777946b0dad7a5813377960a134e9907d3e0669804d273defe90"
const APPX_FILENAME = "Microsoft.HEVCVideoExtension.appxbundle"
const STORE_URL = "ms-windows-store://pdp/?productid=9N4WGH0Z6VHQ"
const GITHUB_RELEASES_URL =
  "https://github.com/infinitel8p/Extreme-InfiniTV/releases/latest"

let inFlight = false

export function isWindowsDesktop(): boolean {
  return isTauri && /Windows/i.test(navigator.userAgent || "")
}

export async function ensureHevcDecodable(options?: { generic?: boolean }): Promise<boolean> {
  if (deviceSupportsHevc()) return true
  if (!isWindowsDesktop() || inFlight) return false
  inFlight = true
  const generic = options?.generic === true

  try {
    if (await invoke<boolean>("is_store_build")) {
      const ok = await confirmDialog({
        title: t("hevc.title") || "Enable HEVC playback",
        message: generic
          ? t("hevc.storeBodyGeneric") ||
            "HEVC playback needs Microsoft's HEVC Video Extensions. Open the Microsoft Store to install it, then restart the app."
          : t("hevc.storeBody") ||
            "This channel needs Microsoft's HEVC Video Extensions. Open the Microsoft Store to install it, then restart the app.",
        confirmLabel: t("hevc.openStore") || "Open Store",
        link: {
          label: t("hevc.githubLink") || "Or download the desktop version from GitHub",
          onClick: () => {
            void openExternal(GITHUB_RELEASES_URL)
          },
        },
      })
      if (ok) await openExternal(STORE_URL)
      return false
    }

    const ok = await confirmDialog({
      title: t("hevc.title") || "Enable HEVC playback",
      message: generic
        ? t("hevc.downloadBodyGeneric") ||
          "Download Microsoft's HEVC component (~8 MB) and restart to enable HEVC playback in the app?"
        : t("hevc.downloadBody") ||
          "This channel is HEVC-encoded. Download Microsoft's HEVC component (~8 MB) and restart to play it in the app?",
      confirmLabel: t("hevc.download") || "Download & install",
    })
    if (!ok) return false

    const progress = toast({
      title: t("hevc.installing") || "Installing HEVC component…",
      duration: 0,
    })
    let path: string
    try {
      path = await downloadAndVerify()
    } catch (err) {
      progress()
      log.error("[xt:hevc] download failed:", err)
      toastError(
        String(err).includes("HASH_MISMATCH")
          ? t("hevc.hashError") || "Download verification failed. Try again later."
          : t("hevc.downloadError") || "Couldn't download the HEVC component.",
        { description: String(err).slice(0, 300) },
      )
      return false
    }
    try {
      await invoke("install_appx_package", { path })
    } catch (err) {
      progress()
      reportInstallError(err)
      return false
    }
    progress()

    const restart = await confirmDialog({
      title: t("hevc.installedTitle") || "HEVC component installed",
      message:
        t("hevc.restartBody") ||
        "Restart the app now to finish enabling HEVC playback.",
      confirmLabel: t("hevc.restart") || "Restart now",
    })
    if (restart) {
      const { relaunch } = await import("@tauri-apps/plugin-process")
      await relaunch()
    }
    return false
  } catch (err) {
    log.warn("[xt:hevc] ensureHevcDecodable failed:", err)
    return false
  } finally {
    inFlight = false
  }
}

async function downloadAndVerify(): Promise<string> {
  const { providerFetch } = await import("@/scripts/lib/provider-fetch.js")
  const response = await providerFetch(APPX_URL, { logKind: "update" })
  if (!response.ok) throw new Error(`download HTTP ${response.status}`)
  const buffer = await response.arrayBuffer()
  if ((await sha256Hex(buffer)) !== APPX_SHA256) throw new Error("HASH_MISMATCH")
  const { appLocalDataDir, join } = await import("@tauri-apps/api/path")
  const fs = await import("@tauri-apps/plugin-fs")
  const path = await join(await appLocalDataDir(), APPX_FILENAME)
  await fs.writeFile(path, new Uint8Array(buffer))
  return path
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function reportInstallError(err: unknown): void {
  const raw = String(err)
  log.error("[xt:hevc] install failed:", raw)
  const detail = raw.replace(/^[A-Z_]+:/, "").trim().slice(0, 300)
  let title: string
  if (raw.startsWith("MISSING_DEP:")) {
    title =
      t("hevc.missingDep") ||
      "A prerequisite (Microsoft VCLibs) is missing. Install it from the Microsoft Store, then retry."
  } else if (raw.startsWith("PERMISSION:")) {
    title = t("hevc.permissionError") || "Windows blocked the install."
  } else if (raw.startsWith("TIMEOUT:")) {
    title = t("hevc.timeout") || "The HEVC install timed out. Try again."
  } else {
    title = t("hevc.installError") || "Couldn't install the HEVC component."
  }
  toastError(title, { description: detail })
}
