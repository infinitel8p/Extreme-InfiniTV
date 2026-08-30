import { describe, it, expect, afterEach, vi } from "vitest"
import { isTrustedWorkerMessage } from "../src/scripts/lib/worker-origin"

function eventWithOrigin(origin: string): MessageEvent {
  return { origin } as MessageEvent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("isTrustedWorkerMessage", () => {
  it("trusts the empty origin a dedicated worker delivers messages with", () => {
    vi.stubGlobal("self", { location: { origin: "https://example.test" } })
    expect(isTrustedWorkerMessage(eventWithOrigin(""))).toBe(true)
  })

  it("trusts a message reporting the same origin as the worker", () => {
    vi.stubGlobal("self", { location: { origin: "https://example.test" } })
    expect(isTrustedWorkerMessage(eventWithOrigin("https://example.test"))).toBe(true)
  })

  it("rejects a message reporting a foreign origin", () => {
    vi.stubGlobal("self", { location: { origin: "https://example.test" } })
    expect(isTrustedWorkerMessage(eventWithOrigin("https://evil.test"))).toBe(false)
  })
})
