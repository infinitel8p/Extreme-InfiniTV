// Linux rendering safe mode: talks to the Rust-managed state in compositing.rs via invoke.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { toastSuccess, toastError } from "@/scripts/lib/toast.js"
import { t } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"

export type CompositingSetting = "auto" | "fast" | "safe" | "fast-trial"
export type CompositingDetection = "raspberry-pi" | "nvidia" | "vm" | null

export interface CompositingState {
  platformSupported: boolean
  detection: CompositingDetection
  setting: CompositingSetting
  active: "fast" | "safe"
  envOverride: boolean
  trialActive: boolean
}

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

export function isLinuxDesktop(): boolean {
  if (!isTauri || typeof navigator === "undefined") return false
  const ua = navigator.userAgent || ""
  return /Linux/i.test(ua) && !/Android/i.test(ua)
}

export async function getCompositingState(): Promise<CompositingState | null> {
  if (!isLinuxDesktop()) return null
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<CompositingState>("compositing_state")
  } catch (err) {
    log.error("[compositing] state fetch failed:", err)
    return null
  }
}

export async function setCompositingSetting(value: CompositingSetting): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("compositing_set", { setting: value })
}

export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process")
  await relaunch()
}

const DIALOG_ID = "xt-compositing-trial-dialog"

function buildTrialDialog(): HTMLDialogElement {
  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(28rem,calc(100vw-2rem))]",
    "backdrop:bg-black/70",
  ].join(" ")
  node.innerHTML = `
    <div class="flex flex-col gap-4 p-5">
      <div class="flex flex-col gap-1.5">
        <h2 id="${DIALOG_ID}-title" class="text-base font-semibold"></h2>
        <p data-role="body" class="text-sm text-fg-2"></p>
      </div>
      <div class="flex gap-2 justify-end">
        <button
          data-role="revert"
          type="button"
          class="rounded-xl border border-line px-4 py-2 text-sm hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent"></button>
        <button
          data-role="keep"
          type="button"
          class="rounded-xl px-4 py-2 text-sm font-semibold bg-accent text-bg hover:opacity-90 focus-visible:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"></button>
      </div>
    </div>
  `

  const titleEl = node.querySelector("h2") as HTMLElement
  const bodyEl = node.querySelector('[data-role="body"]') as HTMLElement
  const keepBtn = node.querySelector('[data-role="keep"]') as HTMLButtonElement
  const revertBtn = node.querySelector('[data-role="revert"]') as HTMLButtonElement
  titleEl.textContent = t("rendering.trial.title")
  bodyEl.textContent = t("rendering.trial.body")
  keepBtn.textContent = t("rendering.trial.keep")
  revertBtn.textContent = t("rendering.trial.switchBack")

  document.body.appendChild(node)
  attachDialogSpatialNav(node, { defaultElement: `#${DIALOG_ID} [data-role="keep"]` })

  keepBtn.addEventListener("click", async () => {
    try {
      await setCompositingSetting("fast")
      toastSuccess(t("rendering.trial.keptToast"))
    } catch (err) {
      log.error("[compositing] failed to keep fast rendering:", err)
      toastError(t("rendering.trial.errorToast"))
    }
    node.close()
  })
  revertBtn.addEventListener("click", async () => {
    try {
      await setCompositingSetting("safe")
    } catch (err) {
      log.error("[compositing] failed to switch back to safe rendering:", err)
      toastError(t("rendering.trial.errorToast"))
      node.close()
      return
    }
    node.close()
    try {
      await relaunchApp()
    } catch (err) {
      log.error("[compositing] relaunch failed:", err)
    }
  })
  node.addEventListener("click", (event) => {
    if (event.target === node) node.close()
  })
  node.addEventListener("close", () => node.remove())

  return node
}

async function showTrialPromptIfNeeded(): Promise<void> {
  if (document.getElementById(DIALOG_ID)) return
  const state = await getCompositingState()
  if (!state?.trialActive) return

  const dialog = buildTrialDialog()
  if (typeof dialog.showModal === "function") dialog.showModal()
  else dialog.setAttribute("open", "")
}

// Mirrors whats-new.ts's afterSplash pattern: wait for the splash overlay to
// finish (or time out) so the dialog never appears mid-splash.
function afterSplash(callback: () => void): void {
  const root = document.documentElement
  if (root.hasAttribute("data-splash-done")) {
    callback()
    return
  }
  const observer = new MutationObserver(() => {
    if (root.hasAttribute("data-splash-done")) {
      observer.disconnect()
      callback()
    }
  })
  observer.observe(root, { attributes: true, attributeFilter: ["data-splash-done"] })
  setTimeout(() => {
    observer.disconnect()
    callback()
  }, 6000)
}

export function mountCompositingTrialPrompt(): void {
  if (!isLinuxDesktop()) return
  afterSplash(() => {
    showTrialPromptIfNeeded().catch((err) =>
      log.error("[compositing] trial prompt failed:", err)
    )
  })
}
