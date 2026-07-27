// One AudioContext shared by ui-sounds.ts and audio-effects.ts (avoid one per feature).

let sharedCtx: AudioContext | null = null

export function getSharedAudioContext(): AudioContext | null {
  if (!sharedCtx) {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    sharedCtx = new Ctor()
  }
  return sharedCtx
}
