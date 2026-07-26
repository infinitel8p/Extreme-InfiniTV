// Audio-track sources for hls.js and shaka-player; mpegts.js/native <video> have none.
import { escapeHtml } from "@/scripts/lib/format.js"
import { ICON_LANGUAGE } from "@/scripts/lib/icons.js"

export interface EmbeddedAudioTrack {
  id: string
  label: string
  language: string | null
  active: boolean
}

export interface AudioTrackSource {
  list(): EmbeddedAudioTrack[]
  select(id: string): void
  subscribe(listener: () => void): () => void
  dispose(): void
}

export interface RawAudioTrackInfo {
  id: string
  name?: string | null
  language?: string | null
  active: boolean
}

function languageLabelFor(languageCode: string, displayNames: Intl.DisplayNames | null): string | null {
  if (!languageCode || languageCode === "und") return null
  if (!displayNames) return languageCode
  try {
    return displayNames.of(languageCode) || languageCode
  } catch {
    return languageCode
  }
}

/** Skips the name when it's redundant with the language display. */
export function combineLanguageAndName(languageDisplay: string | null, trackName: string | undefined): string | null {
  if (!languageDisplay) return trackName || null
  if (!trackName) return languageDisplay
  const normalizedName = trackName.toLowerCase()
  const normalizedLanguage = languageDisplay.toLowerCase()
  if (normalizedName === normalizedLanguage) return languageDisplay
  if (normalizedName.includes(normalizedLanguage)) return trackName
  if (normalizedLanguage.includes(normalizedName)) return languageDisplay
  return `${languageDisplay} (${trackName})`
}

/** Falls back to "Audio N"; duplicate labels get " 2", " 3" suffixes. */
export function labelAudioTracks(rawTracks: RawAudioTrackInfo[], locale = "en"): EmbeddedAudioTrack[] {
  let displayNames: Intl.DisplayNames | null = null
  try {
    displayNames = new Intl.DisplayNames([locale, "en"], { type: "language" })
  } catch {
    displayNames = null
  }
  const seenLabelCounts = new Map<string, number>()
  return rawTracks.map((rawTrack, position) => {
    const trackName = rawTrack.name?.trim()
    const languageCode = (rawTrack.language || "").trim().toLowerCase()
    const languageDisplay = languageLabelFor(languageCode, displayNames)
    const baseLabel = combineLanguageAndName(languageDisplay, trackName) || `Audio ${position + 1}`
    const occurrence = (seenLabelCounts.get(baseLabel) || 0) + 1
    seenLabelCounts.set(baseLabel, occurrence)
    return {
      id: rawTrack.id,
      label: occurrence > 1 ? `${baseLabel} ${occurrence}` : baseLabel,
      language: rawTrack.language ?? null,
      active: rawTrack.active,
    }
  })
}

export function createHlsAudioSource(hls: any): AudioTrackSource {
  const listeners = new Set<() => void>()

  function rawTracks(): RawAudioTrackInfo[] {
    const tracks: any[] = hls.audioTracks ?? []
    return tracks.map((track, index) => ({
      id: String(track.id ?? index),
      name: track.name,
      language: track.lang,
      active: index === hls.audioTrack,
    }))
  }

  function notify(): void {
    for (const listener of listeners) listener()
  }

  hls.on("hlsAudioTracksUpdated", notify)
  hls.on("hlsAudioTrackSwitched", notify)

  return {
    list() {
      return labelAudioTracks(rawTracks())
    },
    select(id) {
      try {
        const tracks: any[] = hls.audioTracks ?? []
        const index = tracks.findIndex((track, trackIndex) => String(track.id ?? trackIndex) === id)
        if (index >= 0) hls.audioTrack = index
      } catch {}
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      hls.off("hlsAudioTracksUpdated", notify)
      hls.off("hlsAudioTrackSwitched", notify)
      listeners.clear()
    },
  }
}

function shakaChannelSuffix(channelsCount: number | null | undefined): string {
  if (channelsCount === 6) return " 5.1"
  if (channelsCount === 2) return " 2.0"
  return ""
}

// Zero safe margin can cause a rebuffer hiccup (Shaka docs).
const SHAKA_AUDIO_SWITCH_SAFE_MARGIN_SECONDS = 4

export function createShakaAudioSource(player: any): AudioTrackSource {
  const listeners = new Set<() => void>()

  function usesAudioTrackApi(): boolean {
    return typeof player.getAudioTracks === "function" && typeof player.selectAudioTrack === "function"
  }

  function rawTracks(): RawAudioTrackInfo[] {
    if (usesAudioTrackApi()) {
      const tracks: any[] = player.getAudioTracks() ?? []
      return tracks.map((track, index) => ({
        id: String(track.id ?? index),
        name: track.label || null,
        language: track.language,
        active: !!track.active,
      }))
    }
    const variants: any[] = player.getVariantTracks?.() ?? []
    const seen = new Map<string, any>()
    for (const variant of variants) {
      const key = `${variant.language ?? ""}|${variant.audioId ?? variant.audioBandwidth ?? ""}`
      if (!seen.has(key)) seen.set(key, variant)
      if (variant.active) seen.set(key, variant)
    }
    return [...seen.values()].map((variant, index) => ({
      id: String(variant.audioId ?? variant.id ?? index),
      name: variant.label ? `${variant.label}${shakaChannelSuffix(variant.channelsCount)}` : null,
      language: variant.language,
      active: !!variant.active,
    }))
  }

  // Rebuild only when the audio group changed, not on ABR steps.
  function trackListSignature(): string {
    return labelAudioTracks(rawTracks())
      .map((track) => `${track.id}|${track.label}|${track.active}`)
      .join(",")
  }

  let lastSignature = trackListSignature()

  function notify(): void {
    const signature = trackListSignature()
    if (signature === lastSignature) return
    lastSignature = signature
    for (const listener of listeners) listener()
  }

  player.addEventListener("trackschanged", notify)
  player.addEventListener("variantchanged", notify)
  player.addEventListener("adaptation", notify)

  return {
    list() {
      return labelAudioTracks(rawTracks())
    },
    select(id) {
      try {
        if (usesAudioTrackApi()) {
          const tracks: any[] = player.getAudioTracks() ?? []
          const track = tracks.find((candidate, index) => String(candidate.id ?? index) === id)
          if (track) player.selectAudioTrack(track, SHAKA_AUDIO_SWITCH_SAFE_MARGIN_SECONDS)
          return
        }
        const variants: any[] = player.getVariantTracks?.() ?? []
        const variant = variants.find(
          (candidate, index) => String(candidate.audioId ?? candidate.id ?? index) === id,
        )
        if (!variant) return
        // Pin language first or ABR adapts back to another audio group.
        if (variant.language && typeof player.selectAudioLanguage === "function") {
          player.selectAudioLanguage(variant.language, variant.roles?.[0])
        } else {
          player.configure({ abr: { enabled: false } })
        }
        player.selectVariantTrack(variant, true, SHAKA_AUDIO_SWITCH_SAFE_MARGIN_SECONDS)
      } catch {}
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      player.removeEventListener("trackschanged", notify)
      player.removeEventListener("variantchanged", notify)
      player.removeEventListener("adaptation", notify)
      listeners.clear()
    },
  }
}

export function attachVideoJsAudioMenu(
  videojs: any,
  player: any,
): { setSource(source: AudioTrackSource | null): void; dispose(): void } {
  let activeSource: AudioTrackSource | null = null
  let unsubscribe: (() => void) | null = null
  let applyingSelection = false

  function clearTracks(): void {
    const audioTrackList = player.audioTracks?.()
    if (!audioTrackList) return
    const tracks: any[] = []
    for (let i = 0; i < audioTrackList.length; i++) tracks.push(audioTrackList[i])
    for (const track of tracks) audioTrackList.removeTrack(track)
  }

  function rebuild(): void {
    const audioTrackList = player.audioTracks?.()
    if (!audioTrackList || !activeSource) return
    clearTracks()
    for (const track of activeSource.list()) {
      audioTrackList.addTrack(
        new videojs.AudioTrack({
          id: track.id,
          kind: track.active ? "main" : "alternative",
          label: track.label,
          language: track.language ?? "",
          enabled: track.active,
        }),
      )
    }
  }

  function onTrackListChange(): void {
    if (applyingSelection || !activeSource) return
    const audioTrackList = player.audioTracks?.()
    if (!audioTrackList) return
    let enabledTrack: any = null
    for (let i = 0; i < audioTrackList.length; i++) {
      if (audioTrackList[i].enabled) {
        enabledTrack = audioTrackList[i]
        break
      }
    }
    if (!enabledTrack) return
    applyingSelection = true
    try {
      activeSource.select(enabledTrack.id)
    } finally {
      applyingSelection = false
    }
  }

  player.audioTracks?.()?.addEventListener("change", onTrackListChange)

  return {
    setSource(source) {
      unsubscribe?.()
      unsubscribe = null
      const previousSource = activeSource
      activeSource = source
      if (previousSource && previousSource !== source) {
        try { previousSource.dispose() } catch {}
      }
      if (!source) {
        clearTracks()
        return
      }
      applyingSelection = true
      try {
        rebuild()
      } finally {
        applyingSelection = false
      }
      unsubscribe = source.subscribe(() => {
        applyingSelection = true
        try {
          rebuild()
        } finally {
          applyingSelection = false
        }
      })
    },
    dispose() {
      unsubscribe?.()
      unsubscribe = null
      const previousSource = activeSource
      activeSource = null
      if (previousSource) {
        try { previousSource.dispose() } catch {}
      }
      player.audioTracks?.()?.removeEventListener("change", onTrackListChange)
      clearTracks()
    },
  }
}

export function attachArtplayerAudioControl(
  art: any,
  translate: (key: string) => string,
): { setSource(source: AudioTrackSource | null): void; dispose(): void } {
  let activeSource: AudioTrackSource | null = null
  let unsubscribe: (() => void) | null = null
  let readyHandlerBound = false

  const controlIcon = ICON_LANGUAGE.replace(
    "<svg ",
    '<svg style="fill:none;width:22px;height:22px" ',
  ).replace('aria-hidden="true"', `role="img" aria-label="${escapeHtml(translate("player.audio"))}"`)

  function removeControl(): void {
    try { art.controls.remove("xtAudio") } catch {}
  }

  function addControl(): void {
    const tracks = activeSource?.list() ?? []
    if (tracks.length < 2) return
    try {
      art.controls.add({
        name: "xtAudio",
        position: "right",
        index: 6,
        html: controlIcon,
        selector: tracks.map((track) => ({
          html: escapeHtml(track.label),
          value: track.id,
          default: track.active,
        })),
        onSelect(item: { html: string; value: unknown }) {
          activeSource?.select(String(item.value))
          return item.html
        },
      })
    } catch {}
  }

  function rebuild(): void {
    removeControl()
    const tracks = activeSource?.list() ?? []
    if (tracks.length < 2) return
    if (art.isReady) {
      addControl()
      return
    }
    if (readyHandlerBound) return
    readyHandlerBound = true
    art.on("ready", addControl)
  }

  return {
    setSource(source) {
      unsubscribe?.()
      unsubscribe = null
      const previousSource = activeSource
      activeSource = source
      if (previousSource && previousSource !== source) {
        try { previousSource.dispose() } catch {}
      }
      if (!source) {
        removeControl()
        return
      }
      rebuild()
      unsubscribe = source.subscribe(rebuild)
    },
    dispose() {
      unsubscribe?.()
      unsubscribe = null
      const previousSource = activeSource
      activeSource = null
      if (previousSource) {
        try { previousSource.dispose() } catch {}
      }
      removeControl()
    },
  }
}
