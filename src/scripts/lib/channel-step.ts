// Pure index math for tuning to the next/previous channel with wrap-around.

export function stepChannelIndex(currentIndex: number, count: number, delta: number): number | null {
  if (count <= 0) return null
  if (currentIndex < 0) return delta < 0 ? count - 1 : 0
  return (((currentIndex + delta) % count) + count) % count
}

const CHANNEL_UP_KEYS = new Set(["ChannelUp", "MediaChannelUp"])
const CHANNEL_DOWN_KEYS = new Set(["ChannelDown", "MediaChannelDown"])

export function channelKeyDirection(key: string | null | undefined, keyCode: number): number | null {
  if (key && CHANNEL_UP_KEYS.has(key)) return 1
  if (key && CHANNEL_DOWN_KEYS.has(key)) return -1
  // keyCode fallback only for unmapped keys: Android WebView reports channel keys as
  // 166/167 with no DOM key, but on Windows 166/167 are BrowserBack/BrowserForward.
  const unmapped = !key || key === "Unidentified"
  if (unmapped && keyCode === 166) return 1
  if (unmapped && keyCode === 167) return -1
  return null
}
