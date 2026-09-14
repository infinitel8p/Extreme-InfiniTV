import { describe, it, expect } from "vitest"
import { computeMpvSurface, type MpvSurfaceNativeState } from "../src/scripts/lib/mpv-embedded-surface"

const NATIVE_STATES: MpvSurfaceNativeState[] = ["hidden", "embedded", "fullscreen", "pip"]

describe("computeMpvSurface", () => {
  it("opens the hole only when embedded, revealed, and page bounds are valid", () => {
    expect(
      computeMpvSurface({ nativeState: "embedded", revealed: true, pageBounds: true, loading: false }),
    ).toEqual({ holeOpen: true, placeholder: "none" })
  })

  it("opens the hole when fullscreen, revealed, and page bounds are valid", () => {
    expect(
      computeMpvSurface({ nativeState: "fullscreen", revealed: true, pageBounds: true, loading: false }),
    ).toEqual({ holeOpen: true, placeholder: "none" })
  })

  it("keeps the hole closed while not revealed, even when embedded", () => {
    expect(
      computeMpvSurface({ nativeState: "embedded", revealed: false, pageBounds: true, loading: false }),
    ).toMatchObject({ holeOpen: false })
  })

  it("keeps the hole closed without valid page bounds, even when embedded and revealed", () => {
    expect(
      computeMpvSurface({ nativeState: "embedded", revealed: true, pageBounds: false, loading: false }),
    ).toMatchObject({ holeOpen: false })
  })

  it("keeps the hole closed for hidden and pip states regardless of revealed/pageBounds", () => {
    for (const nativeState of ["hidden", "pip"] as const) {
      expect(
        computeMpvSurface({ nativeState, revealed: true, pageBounds: true, loading: false }),
      ).toMatchObject({ holeOpen: false })
    }
  })

  it("shows the pip placeholder whenever the native state is pip", () => {
    expect(
      computeMpvSurface({ nativeState: "pip", revealed: true, pageBounds: true, loading: false }),
    ).toEqual({ holeOpen: false, placeholder: "pip" })
    expect(
      computeMpvSurface({ nativeState: "pip", revealed: false, pageBounds: false, loading: true }),
    ).toEqual({ holeOpen: false, placeholder: "pip" })
  })

  it("shows the loading placeholder only when not revealed and a load is in flight", () => {
    expect(
      computeMpvSurface({ nativeState: "hidden", revealed: false, pageBounds: false, loading: true }),
    ).toEqual({ holeOpen: false, placeholder: "loading" })
    expect(
      computeMpvSurface({ nativeState: "embedded", revealed: false, pageBounds: true, loading: true }),
    ).toEqual({ holeOpen: false, placeholder: "loading" })
  })

  it("does not show the loading placeholder once revealed, even mid-load", () => {
    expect(
      computeMpvSurface({ nativeState: "embedded", revealed: true, pageBounds: true, loading: true }),
    ).toMatchObject({ placeholder: "none" })
  })

  it("shows no placeholder when idle and nothing is loading", () => {
    expect(
      computeMpvSurface({ nativeState: "hidden", revealed: false, pageBounds: false, loading: false }),
    ).toEqual({ holeOpen: false, placeholder: "none" })
  })

  it("pip placeholder wins over a loading state", () => {
    expect(
      computeMpvSurface({ nativeState: "pip", revealed: false, pageBounds: true, loading: true }),
    ).toMatchObject({ placeholder: "pip" })
  })

  it("covers every native state without throwing", () => {
    for (const nativeState of NATIVE_STATES) {
      expect(() =>
        computeMpvSurface({ nativeState, revealed: false, pageBounds: false, loading: false }),
      ).not.toThrow()
    }
  })
})
