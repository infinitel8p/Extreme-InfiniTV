// Shared PiP toggle for Video.js players. On Tauri Android the WebView
// can't host Web PiP, so we route through the AndroidPip JS bridge which
// puts the entire activity into PiP - but only after the player has gone
// fullscreen, which triggers the WebChromeClient custom view so PiP
// captures just the video surface. On desktop, falls back to the standard
// Web Picture-in-Picture API on the underlying <video>.
export async function togglePip(player: any): Promise<void> {
  const videoEl = player?.el()?.querySelector("video") as HTMLVideoElement | null
  if (!videoEl) return

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

  if (document.pictureInPictureEnabled && !videoEl.disablePictureInPicture) {
    try {
      if (document.pictureInPictureElement === videoEl) {
        await document.exitPictureInPicture()
      } else {
        if (videoEl.readyState < 2) await videoEl.play().catch(() => {})
        await videoEl.requestPictureInPicture()
      }
    } catch {}
  }
}
