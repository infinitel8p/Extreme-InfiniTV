// GET_CONTENT fallback client for the AndroidFilePick bridge in MainActivity.kt.

declare global {
  interface Window {
    AndroidFilePick?: {
      canPickContent(mimeType: string): boolean
      pickText(requestId: string, mimeTypesCsv: string): boolean
    }
  }
}

interface FilePickedDetail {
  requestId: string
  ok: boolean
  cancelled?: boolean
  text?: string
  name?: string
  error?: string
}

export function androidContentPickerAvailable(mimeType = "*/*"): boolean {
  return !!window.AndroidFilePick?.canPickContent(mimeType)
}

export function pickTextFileViaIntent(
  mimeTypes: string[]
): Promise<{ text: string; name: string } | null> {
  return new Promise((resolve, reject) => {
    const bridge = window.AndroidFilePick
    if (!bridge) {
      reject(new Error("AndroidFilePick bridge unavailable"))
      return
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`

    const onPicked = (event: Event) => {
      const detail = (event as CustomEvent<FilePickedDetail>).detail
      if (!detail || detail.requestId !== requestId) return
      document.removeEventListener("xt:android-file-picked", onPicked)
      if (detail.cancelled) {
        resolve(null)
        return
      }
      if (!detail.ok) {
        reject(new Error(detail.error || "file pick failed"))
        return
      }
      resolve({ text: detail.text ?? "", name: detail.name ?? "" })
    }
    document.addEventListener("xt:android-file-picked", onPicked)

    const launched = bridge.pickText(requestId, mimeTypes.join(","))
    if (!launched) {
      document.removeEventListener("xt:android-file-picked", onPicked)
      reject(new Error("no file picker available"))
    }
  })
}
