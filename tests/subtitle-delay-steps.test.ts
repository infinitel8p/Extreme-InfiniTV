import { describe, expect, it } from "vitest"
import { SUBTITLE_DELAY_STEPS_MS, formatDelayStepLabel, formatDelayValue } from "@/scripts/lib/subtitle-delay-steps"

const translate = (key: string, params?: Record<string, string | number>) => `${key}:${params?.ms}`

describe("subtitle delay steps", () => {
  it("lists symmetric steps", () => {
    expect(SUBTITLE_DELAY_STEPS_MS).toEqual([-500, -250, -100, 100, 250, 500])
  })

  it("signs step labels", () => {
    expect(formatDelayStepLabel(250, translate)).toBe("player.mpv.subtitleDelay.value:+250")
    expect(formatDelayStepLabel(-100, translate)).toBe("player.mpv.subtitleDelay.value:-100")
  })

  it("rounds seconds to signed milliseconds", () => {
    expect(formatDelayValue(0.3, translate)).toBe("player.mpv.subtitleDelay.value:+300")
    expect(formatDelayValue(-0.1004, translate)).toBe("player.mpv.subtitleDelay.value:-100")
    expect(formatDelayValue(0, translate)).toBe("player.mpv.subtitleDelay.value:+0")
  })
})
