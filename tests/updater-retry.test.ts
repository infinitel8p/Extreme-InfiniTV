import { describe, it, expect, vi } from "vitest"
import { isTransientUpdaterError, withUpdaterRetry } from "@/scripts/lib/update-check.js"

describe("isTransientUpdaterError", () => {
  it("matches reqwest transport failures surfaced by the updater command", () => {
    const message =
      "OTHER:error sending request for url (https://github.com/infinitel8p/Extreme-InfiniTV/releases/download/v1.8.0-beta.106/latest.json)"
    expect(isTransientUpdaterError(new Error(message))).toBe(true)
    expect(isTransientUpdaterError(message)).toBe(true)
  })

  it("matches timeouts, connection resets and decode failures", () => {
    expect(isTransientUpdaterError(new Error("operation timed out"))).toBe(true)
    expect(isTransientUpdaterError(new Error("connection reset by peer"))).toBe(true)
    expect(isTransientUpdaterError(new Error("error decoding response body"))).toBe(true)
    expect(isTransientUpdaterError(new Error("TypeError: Failed to fetch"))).toBe(true)
  })

  it("rejects permanent failures", () => {
    expect(isTransientUpdaterError(new Error("could not find any updater target"))).toBe(false)
    expect(isTransientUpdaterError(new Error("signature verification failed"))).toBe(false)
    expect(isTransientUpdaterError(new Error("APPIMAGE environment variable not found"))).toBe(false)
    expect(isTransientUpdaterError(null)).toBe(false)
  })
})

describe("withUpdaterRetry", () => {
  it("returns the first successful result without retrying", async () => {
    const run = vi.fn().mockResolvedValue({ version: "1.8.0" })
    await expect(withUpdaterRetry(run)).resolves.toEqual({ version: "1.8.0" })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("passes a null (up-to-date) result straight through", async () => {
    const run = vi.fn().mockResolvedValue(null)
    await expect(withUpdaterRetry(run)).resolves.toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("gives up immediately on a permanent failure", async () => {
    const run = vi.fn().mockRejectedValue(new Error("signature verification failed"))
    await expect(withUpdaterRetry(run)).rejects.toThrow("signature verification failed")
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("retries a transient failure and resolves once it succeeds", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("OTHER:error sending request for url (https://github.com/x)"))
      .mockResolvedValue({ version: "1.8.0-beta.106" })
    await expect(withUpdaterRetry(run)).resolves.toEqual({ version: "1.8.0-beta.106" })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("rethrows after exhausting its attempts", async () => {
    const run = vi.fn().mockRejectedValue(new Error("error sending request for url (https://github.com/x)"))
    await expect(withUpdaterRetry(run)).rejects.toThrow("error sending request")
    expect(run).toHaveBeenCalledTimes(3)
  })
})
