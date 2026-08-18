import { describe, it, expect } from "vitest"
import { deriveVerdict, type DiagnosticStep } from "../src/scripts/lib/diagnostic"

function step(labelKey: string, status: DiagnosticStep["status"]): DiagnosticStep {
  return { labelKey, status }
}

describe("deriveVerdict", () => {
  it("returns ok/allGood when every core step passes", () => {
    const steps = [
      step("diagnostic.step.auth", "pass"),
      step("diagnostic.step.live", "pass"),
      step("diagnostic.step.vod", "pass"),
      step("diagnostic.step.series", "pass"),
    ]
    expect(deriveVerdict(steps)).toEqual({ verdict: "ok", messageKey: "diagnostic.verdict.allGood" })
  })

  it("returns warn/partial when a core step warns", () => {
    const steps = [
      step("diagnostic.step.auth", "pass"),
      step("diagnostic.step.live", "warn"),
      step("diagnostic.step.vod", "pass"),
    ]
    expect(deriveVerdict(steps)).toEqual({ verdict: "warn", messageKey: "diagnostic.verdict.partial" })
  })

  it("returns fail when a core step fails", () => {
    const steps = [
      step("diagnostic.step.auth", "fail"),
    ]
    expect(deriveVerdict(steps).verdict).toBe("fail")
  })

  it("returns warn/auxWarn when only an auxiliary step warns", () => {
    const steps = [
      step("diagnostic.step.auth", "pass"),
      step("diagnostic.step.live", "pass"),
      step("diagnostic.step.epg", "warn"),
    ]
    expect(deriveVerdict(steps)).toEqual({ verdict: "warn", messageKey: "diagnostic.verdict.auxWarn" })
  })

  it("returns warn/auxWarn when only an auxiliary step fails", () => {
    const steps = [
      step("diagnostic.step.auth", "pass"),
      step("diagnostic.step.live", "pass"),
      step("diagnostic.step.stream", "fail"),
    ]
    expect(deriveVerdict(steps)).toEqual({ verdict: "warn", messageKey: "diagnostic.verdict.auxWarn" })
  })

  it("returns ok/allGood when auxiliary steps are skipped", () => {
    const steps = [
      step("diagnostic.step.auth", "pass"),
      step("diagnostic.step.live", "pass"),
      step("diagnostic.step.epg", "skip"),
      step("diagnostic.step.updater", "skip"),
      step("diagnostic.step.stream", "skip"),
    ]
    expect(deriveVerdict(steps)).toEqual({ verdict: "ok", messageKey: "diagnostic.verdict.allGood" })
  })

  it("returns warn/partial when a core step warns and an auxiliary step fails (core wins)", () => {
    const steps = [
      step("diagnostic.step.auth", "pass"),
      step("diagnostic.step.live", "warn"),
      step("diagnostic.step.stream", "fail"),
    ]
    expect(deriveVerdict(steps)).toEqual({ verdict: "warn", messageKey: "diagnostic.verdict.partial" })
  })

  it("returns ok/allGood for an empty step list", () => {
    expect(deriveVerdict([])).toEqual({ verdict: "ok", messageKey: "diagnostic.verdict.allGood" })
  })
})
