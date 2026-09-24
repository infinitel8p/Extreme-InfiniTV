// Shared PiP toggle: Web PiP / AndroidPip on a real <video>, native mpv PiP otherwise.
import { log } from "@/scripts/lib/log.js"

interface MpvEmbedStatus {
  running: boolean
  sessionId: string | null
  pid: number | null
  pipActive: boolean
}

async function toggleNativeMpvPip(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const status = await invoke<MpvEmbedStatus>("mpv_embed_status")
    if (!status?.running || !status.sessionId) return
    const command = status.pipActive ? "mpv_embed_pip_exit" : "mpv_embed_pip_enter"
    await invoke(command, { sessionId: status.sessionId })
  } catch (err) {
    log.warn("[xt:pip] native mpv pip toggle failed:", err)
  }
}

export async function togglePip(player: any): Promise<void> {
  // getMediaElement() is authoritative even when null (mpv-embedded has no <video>).
  const definesMediaElement = typeof player?.getMediaElement === "function"
  const mediaEl: HTMLVideoElement | null = definesMediaElement
    ? player.getMediaElement()
    : (player?.el?.()?.querySelector("video") ?? null)

  if (!mediaEl) {
    if (definesMediaElement) await toggleNativeMpvPip()
    return
  }

  if (window.AndroidPip?.toggle) {
    if (window.AndroidPip.isInPip?.()) {
      window.AndroidPip.toggle()
      return
    }
    if (!document.fullscreenElement) {
      try {
        player.requestFullscreen()
      } catch {}
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    }
    window.AndroidPip.toggle()
    return
  }

  if (document.pictureInPictureEnabled && !mediaEl.disablePictureInPicture) {
    try {
      if (document.pictureInPictureElement === mediaEl) {
        await document.exitPictureInPicture()
      } else {
        if (mediaEl.readyState < 2) await mediaEl.play().catch(() => {})
        await mediaEl.requestPictureInPicture()
      }
    } catch (err) {
      log.warn("[xt:pip] picture-in-picture toggle failed:", err)
    }
  }
}
