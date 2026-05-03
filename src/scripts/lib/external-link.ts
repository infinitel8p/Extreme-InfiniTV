// Route http(s) link clicks to the system default browser via `tauri-plugin-opener`
import { log } from "@/scripts/lib/log.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)

type OpenUrlFn = (url: string) => Promise<void>
let openerPromise: Promise<OpenUrlFn | null> | null = null
async function getOpener(): Promise<OpenUrlFn | null> {
  if (!isTauri) return null
  if (!openerPromise) {
    openerPromise = import("@tauri-apps/plugin-opener")
      .then((mod) => mod.openUrl as OpenUrlFn)
      .catch((error) => {
        log.warn("[xt:external] plugin-opener import failed:", error)
        return null
      })
  }
  return openerPromise
}

export async function openExternal(url: string): Promise<void> {
  if (!url) return
  if (!isTauri) {
    window.open(url, "_blank", "noopener,noreferrer")
    return
  }
  const openUrl = await getOpener()
  if (!openUrl) {
    window.open(url, "_blank", "noopener,noreferrer")
    return
  }
  try {
    await openUrl(url)
  } catch (error) {
    log.warn("[xt:external] openUrl failed:", error)
    window.open(url, "_blank", "noopener,noreferrer")
  }
}

export function bindExternalLinks(root: ParentNode = document): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[data-external]")) {
    if (anchor.dataset.externalBound === "1") continue
    anchor.dataset.externalBound = "1"
    anchor.addEventListener("click", (event) => {
      const href = anchor.getAttribute("href") || ""
      if (!/^https?:\/\//i.test(href)) return
      event.preventDefault()
      openExternal(href)
    })
  }
}
