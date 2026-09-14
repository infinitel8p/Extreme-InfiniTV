import { describe, expect, it } from "vitest"
import {
  REJECTION_STATUSES,
  parseHttpStatusFromDetail,
  isProviderRejection,
  shouldRepinMirror,
} from "../src/scripts/lib/stream-reject"

describe("REJECTION_STATUSES", () => {
  it("covers the auth refusals and the connection-limit statuses", () => {
    expect(REJECTION_STATUSES.has(401)).toBe(true)
    expect(REJECTION_STATUSES.has(403)).toBe(true)
    expect(REJECTION_STATUSES.has(407)).toBe(true)
    expect(REJECTION_STATUSES.has(429)).toBe(true)
    expect(REJECTION_STATUSES.has(458)).toBe(true)
    expect(REJECTION_STATUSES.has(509)).toBe(true)
  })

  it("does not include unrelated statuses", () => {
    expect(REJECTION_STATUSES.has(200)).toBe(false)
    expect(REJECTION_STATUSES.has(404)).toBe(false)
    expect(REJECTION_STATUSES.has(500)).toBe(false)
  })
})

describe("parseHttpStatusFromDetail", () => {
  it("reads the status our hls.js path appends", () => {
    expect(parseHttpStatusFromDetail("manifestLoadError (HTTP 403)")).toBe(403)
  })

  it("reads the status out of a shaka BAD_HTTP_STATUS payload", () => {
    expect(
      parseHttpStatusFromDetail('shaka:network:1001 ["http://host/live/u/p/1.m3u8",458,"",{},1]')
    ).toBe(458)
  })

  it("returns null when no status is present", () => {
    expect(parseHttpStatusFromDetail("bufferStalledError")).toBe(null)
    expect(parseHttpStatusFromDetail("")).toBe(null)
    expect(parseHttpStatusFromDetail(null)).toBe(null)
    expect(parseHttpStatusFromDetail(undefined)).toBe(null)
  })
})

describe("isProviderRejection", () => {
  it("matches a rejection status parsed out of errorDetail", () => {
    expect(isProviderRejection({ errorDetail: "manifestLoadError (HTTP 403)" })).toBe(true)
    expect(isProviderRejection({ errorDetail: "manifestLoadError (HTTP 429)" })).toBe(true)
    expect(isProviderRejection({ errorDetail: "manifestLoadError (HTTP 458)" })).toBe(true)
  })

  it("matches an explicit httpStatus without needing errorDetail", () => {
    expect(isProviderRejection({ httpStatus: 407 })).toBe(true)
  })

  it("prefers the explicit httpStatus over errorDetail when both are given", () => {
    expect(isProviderRejection({ errorDetail: "manifestLoadError (HTTP 200)", httpStatus: 401 })).toBe(true)
  })

  it("matches failureKind connection-limit regardless of status", () => {
    expect(isProviderRejection({ failureKind: "connection-limit" })).toBe(true)
    expect(isProviderRejection({ failureKind: "connection-limit", httpStatus: 200 })).toBe(true)
  })

  it("rejects statuses and kinds outside the provider-rejection set", () => {
    expect(isProviderRejection({ errorDetail: "manifestLoadError (HTTP 404)" })).toBe(false)
    expect(isProviderRejection({ errorDetail: "manifestLoadError (HTTP 500)" })).toBe(false)
    expect(isProviderRejection({ failureKind: "hevc" })).toBe(false)
    expect(isProviderRejection({})).toBe(false)
  })
})

describe("shouldRepinMirror", () => {
  it("is true for the connection-limit statuses", () => {
    expect(shouldRepinMirror({ httpStatus: 429 })).toBe(true)
    expect(shouldRepinMirror({ httpStatus: 458 })).toBe(true)
    expect(shouldRepinMirror({ httpStatus: 509 })).toBe(true)
    expect(shouldRepinMirror({ errorDetail: "manifestLoadError (HTTP 458)" })).toBe(true)
  })

  it("is false for a one-off auth rejection, since that may be scoped to a single channel", () => {
    expect(shouldRepinMirror({ httpStatus: 401 })).toBe(false)
    expect(shouldRepinMirror({ httpStatus: 403 })).toBe(false)
    expect(shouldRepinMirror({ httpStatus: 407 })).toBe(false)
  })

  it("is false when no status is present", () => {
    expect(shouldRepinMirror({})).toBe(false)
    expect(shouldRepinMirror({ errorDetail: "bufferStalledError" })).toBe(false)
  })
})
