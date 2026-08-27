// Android-only screen wake lock toggle, shared by the receiver page and TV browse playback.
export function setKeepScreenOn(enabled: boolean): void {
  try { window.AndroidVideo?.setKeepScreenOn?.(enabled) } catch {}
}
