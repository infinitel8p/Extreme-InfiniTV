// Runs the ambient dominant-colour sample off the main thread.

import { dominantColor, type RgbColor } from "@/scripts/lib/ambient-math"

const SAMPLE_MAX_DIM = 48

interface BitmapRequest {
  requestId: number
  bitmap: ImageBitmap
}

interface RawBytesRequest {
  requestId: number
  bytes: Uint8ClampedArray
  width: number
  height: number
}

type IncomingMessage = BitmapRequest | RawBytesRequest

export interface AmbientWorkerResponse {
  requestId: number
  rgb: RgbColor | null
}

function post(message: AmbientWorkerResponse): void {
  ;(self as unknown as Worker).postMessage(message)
}

function sampleBitmap(bitmap: ImageBitmap): RgbColor | null {
  const scale = Math.min(1, SAMPLE_MAX_DIM / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, width, height)
  const { data } = ctx.getImageData(0, 0, width, height)
  return dominantColor(data, width, height)
}

self.addEventListener("message", (event: MessageEvent<IncomingMessage>) => {
  const message = event.data
  if (!message) return
  try {
    if ("bitmap" in message) {
      const rgb = typeof OffscreenCanvas === "undefined" ? null : sampleBitmap(message.bitmap)
      message.bitmap.close()
      post({ requestId: message.requestId, rgb })
      return
    }
    const rgb = dominantColor(message.bytes, message.width, message.height)
    post({ requestId: message.requestId, rgb })
  } catch {
    post({ requestId: message.requestId, rgb: null })
  }
})
