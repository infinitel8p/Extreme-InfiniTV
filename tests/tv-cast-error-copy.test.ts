import { describe, it, expect } from "vitest"
import { castErrorInlineText, castErrorToastTitle, type TranslateFn } from "../src/scripts/lib/tv-cast-error-copy"

const stubT: TranslateFn = (key, params) => {
  const template: Record<string, string> = {
    "cast.remote.errorGeneric": "generic",
    "cast.remote.errorDetail": "detail:{detail}",
    "cast.toast.failed": "failed on {device}",
    "cast.toast.playbackError": "failed on {device}: {error}",
    "cast.toast.wakeFailed": "wake failed on {device}",
    "receiver.error.rejected": "rejected",
    "receiver.error.notReady": "not ready",
  }
  let text = template[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replace(`{${name}}`, String(value))
    }
  }
  return text
}

describe("castErrorInlineText", () => {
  it("falls back to the generic message when there is no error", () => {
    expect(castErrorInlineText(undefined, "Living Room", stubT)).toBe("generic")
    expect(castErrorInlineText(null, "Living Room", stubT)).toBe("generic")
    expect(castErrorInlineText("", "Living Room", stubT)).toBe("generic")
  })

  it("maps known receiver slugs to their translated message", () => {
    expect(castErrorInlineText("app-not-foreground", "Living Room", stubT)).toBe("wake failed on Living Room")
    expect(castErrorInlineText("bad-descriptor", "Living Room", stubT)).toBe("rejected")
    expect(castErrorInlineText("play-failed", "Living Room", stubT)).toBe("rejected")
    expect(castErrorInlineText("player-unavailable", "Living Room", stubT)).toBe("not ready")
  })

  it("shows an unknown error as an already-localized sentence, not demoted to a log", () => {
    expect(castErrorInlineText("This TV can't decode HEVC video.", "Living Room", stubT)).toBe(
      "detail:This TV can't decode HEVC video."
    )
  })
})

describe("castErrorToastTitle", () => {
  it("falls back to the bare failed toast when there is no error", () => {
    expect(castErrorToastTitle(undefined, "Living Room", stubT)).toBe("failed on Living Room")
  })

  it("maps known receiver slugs to their translated message", () => {
    expect(castErrorToastTitle("app-not-foreground", "Living Room", stubT)).toBe("wake failed on Living Room")
    expect(castErrorToastTitle("bad-descriptor", "Living Room", stubT)).toBe("rejected")
    expect(castErrorToastTitle("play-failed", "Living Room", stubT)).toBe("rejected")
    expect(castErrorToastTitle("player-unavailable", "Living Room", stubT)).toBe("not ready")
  })

  it("passes an unknown error sentence through the playback-error toast", () => {
    expect(castErrorToastTitle("This TV can't decode HEVC video.", "Living Room", stubT)).toBe(
      "failed on Living Room: This TV can't decode HEVC video."
    )
  })
})
