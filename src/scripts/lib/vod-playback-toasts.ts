// Shared VOD playback-failure toasts for the detail pages.
import { t } from "@/scripts/lib/i18n.js"
import { toastError } from "@/scripts/lib/toast.js"
import { hasAvailableExternalPlayer } from "@/scripts/lib/external-player-button.ts"
import { describeAudioCodec } from "@/scripts/lib/codec-hints.ts"

export interface VodPlaybackToasts {
  /** WebKit desktop can't demux this container and there is no remux path available for it. */
  showContainerUnsupportedToast(container: string): void
  /** The source is a real media file the platform still can't play, and the container is unknown. */
  showFormatUnsupportedToast(): void
  /** The remux failed because the provider itself rejected/failed the request, not because of the container. */
  showSourceUnavailableToast(): void
  /** The container opened fine (remux worked); this device just has no HEVC decoder (e.g. Linux WebKitGTK). */
  showHevcUnsupportedToast(): void
  /** The container opened fine; this platform has no decoder for the audio codec (e.g. DTS on WebKitGTK/WebView2). */
  showAudioUnsupportedToast(codec: string): void
}

/** refreshExternalButton runs after every toast so the escape-hatch button reflects the failure. */
export function createVodPlaybackToasts(refreshExternalButton: () => void): VodPlaybackToasts {
  function showContainerUnsupportedToast(container: string) {
    const descriptionKey = hasAvailableExternalPlayer()
      ? "detail.error.containerUnsupportedHint"
      : "detail.error.containerUnsupportedHintNoPlayer"
    toastError(t("detail.error.containerUnsupported", { container: container.toUpperCase() }), {
      description: t(descriptionKey),
    })
    refreshExternalButton()
  }

  function showFormatUnsupportedToast() {
    const descriptionKey = hasAvailableExternalPlayer()
      ? "detail.error.containerUnsupportedHint"
      : "detail.error.containerUnsupportedHintNoPlayer"
    toastError(t("detail.error.formatUnsupported"), { description: t(descriptionKey) })
    refreshExternalButton()
  }

  function showSourceUnavailableToast() {
    toastError(t("detail.error.sourceUnavailable"))
    refreshExternalButton()
  }

  function showHevcUnsupportedToast() {
    toastError(t("detail.error.hevcUnsupported"), {
      description: t("detail.error.containerUnsupportedHint"),
    })
    refreshExternalButton()
  }

  function showAudioUnsupportedToast(codec: string) {
    toastError(t("detail.error.audioUnsupported", { codec: describeAudioCodec(codec) }), {
      description: t("detail.error.containerUnsupportedHint"),
    })
    refreshExternalButton()
  }

  return {
    showContainerUnsupportedToast,
    showFormatUnsupportedToast,
    showSourceUnavailableToast,
    showHevcUnsupportedToast,
    showAudioUnsupportedToast,
  }
}
