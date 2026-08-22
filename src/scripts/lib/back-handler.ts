// Android BACK key routing. MainActivity calls window.__xtHandleBack() and
// falls through to WebView history / app exit when it returns false.

type BackInterceptor = () => boolean

const interceptors: BackInterceptor[] = []

export function registerBackInterceptor(interceptor: BackInterceptor): () => void {
  interceptors.push(interceptor)
  return () => {
    const index = interceptors.indexOf(interceptor)
    if (index >= 0) interceptors.splice(index, 1)
  }
}

function handleBack(): boolean {
  for (let i = interceptors.length - 1; i >= 0; i--) {
    try {
      if (interceptors[i]()) return true
    } catch {}
  }
  const openDialogs = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]"))
  const topDialog = openDialogs[openDialogs.length - 1]
  if (topDialog) {
    topDialog.close()
    return true
  }
  try {
    const openPopover = document.querySelector<HTMLElement>("[popover]:popover-open")
    if (openPopover) {
      openPopover.hidePopover()
      return true
    }
  } catch {}
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {})
    return true
  }
  return false
}

export function mountBackHandler(): void {
  ;(window as any).__xtHandleBack = handleBack
}
