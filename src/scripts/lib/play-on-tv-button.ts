// "Play on TV" escape-hatch button, VOD-only (movies/series detail); mirrors external-player-button.ts.

import { isTauri, getActiveDnsOverride } from "@/scripts/lib/creds.js"
import { resolveStreamUrl } from "@/scripts/lib/xtream-api.js"
import { isCastableSrc, buildVodCastDescriptor } from "@/scripts/lib/tv-cast-descriptor.js"
import { playOnTv, type PlayOnTvOptions } from "@/scripts/lib/tv-cast.js"
import { log } from "@/scripts/lib/log.js"
import { LOCALE_EVENT } from "@/scripts/lib/i18n.js"

export interface PlayOnTvCastContext {
  vodContext?: PlayOnTvOptions["vodContext"]
  seriesContext?: PlayOnTvOptions["seriesContext"]
}

export interface PlayOnTvHooks {
  getSrcBuilder?: () => ((creds: any) => string) | null
  getSrc?: () => string | null
  getTitle?: () => string | null
  getLogo?: () => string | null
  getResumeSeconds?: () => number
  getDurationSeconds?: () => number | undefined
  /** Keeps receiver next/prev and series auto-advance working for a cast started from this button. */
  getCastContext?: () => PlayOnTvCastContext | null
  beforeCast?: () => void
}

export interface PlayOnTvButtonHandle {
  refresh: () => void
  dispose: () => void
}

export function setupPlayOnTvButton(
  button: HTMLElement | null,
  hooks: PlayOnTvHooks
): PlayOnTvButtonHandle {
  if (!button) return { refresh: () => {}, dispose: () => {} }

  const refresh = () => {
    const hasSource = !!hooks.getSrcBuilder?.() || !!hooks.getSrc?.()
    button.hidden = !isTauri || !hasSource
  }

  const onClick = async () => {
    const builder = hooks.getSrcBuilder?.()
    let src: string | null = null
    try {
      src = builder ? await resolveStreamUrl(builder) : hooks.getSrc?.() || null
    } catch (err) {
      log.warn("[xt:play-on-tv] failed to resolve stream url:", err)
    }
    const title = hooks.getTitle?.() || ""
    const descriptor =
      src && isCastableSrc(src)
        ? buildVodCastDescriptor({
            src,
            title,
            logo: hooks.getLogo?.() || undefined,
            resumeSeconds: hooks.getResumeSeconds?.(),
            durationSeconds: hooks.getDurationSeconds?.(),
          })
        : null
    if (descriptor) descriptor.dns = getActiveDnsOverride()?.raw ?? null
    const castContext = hooks.getCastContext?.() || null
    await playOnTv({
      buildDescriptor: () => descriptor,
      stopLocal: hooks.beforeCast,
      contentTitle: title || null,
      vodContext: castContext?.vodContext,
      seriesContext: castContext?.seriesContext,
    })
  }

  button.addEventListener("click", onClick)
  document.addEventListener(LOCALE_EVENT, refresh)

  refresh()

  return {
    refresh,
    dispose() {
      button.removeEventListener("click", onClick)
      document.removeEventListener(LOCALE_EVENT, refresh)
    },
  }
}
