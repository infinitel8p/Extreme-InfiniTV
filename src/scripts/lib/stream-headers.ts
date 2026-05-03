// Apply per-channel HTTP headers to the WebView before media playback.
//
// IPTV M3U playlists frequently include `#EXTVLCOPT:http-user-agent="..."` and
// `#EXTVLCOPT:http-referrer="..."` directives that VLC and similar players use
// to fetch streams from providers that gate on UA / Referer. The parser
// captures both; this module is the application side.
//
// Coverage by runtime:
// - Tauri Android: WebView.getSettings().setUserAgentString(ua) is reachable
//   via the AndroidWebSettings JS bridge installed in MainActivity.kt. UA
//   takes effect for subsequent media fetches by Video.js. Referer cannot be
//   set per-request from a WebView - documented limitation, parsed-but-unused.
// - Tauri desktop (wry: WebView2 / WKWebView / webkit2gtk): wry exposes UA
//   only at WebView construction, not at runtime. Per-channel UA is a no-op
//   here. Users with a desktop provider that needs a custom UA can set it
//   globally in Settings -> Network.
// - Web build: browsers reject scripted UA / Referer overrides by design.
//   No-op.

interface AndroidWebSettingsBridge {
  setUserAgent(ua: string | null): void
}

declare global {
  interface Window {
    AndroidWebSettings?: AndroidWebSettingsBridge
  }
}

export interface StreamHeaders {
  userAgent: string | null
  referer: string | null
}

let lastAppliedUa: string | null = null

export async function applyStreamHeaders(
  headers: StreamHeaders | null
): Promise<void> {
  const ua = headers?.userAgent ?? null
  if (ua === lastAppliedUa) return
  lastAppliedUa = ua
  try {
    window.AndroidWebSettings?.setUserAgent(ua)
  } catch {}
}
