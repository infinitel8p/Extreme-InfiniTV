/**
 * @vitest-environment jsdom
 *
 * Covers the NSD/subnet-sweep race fixed in discoverReceivers: the sweep must start
 * concurrently after a short grace period (not only after the full NSD window, and not
 * only when NSD comes back empty), a still-running sweep must be shared across concurrent
 * scans, and results from a cancelled scan must never reach stale callbacks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const invokeMock = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { discoverReceivers, type DiscoveredReceiver } from "@/scripts/lib/receiver-discovery.ts"

function makeReceiver(overrides: Partial<DiscoveredReceiver> = {}): DiscoveredReceiver {
  return { name: "Living Room TV", host: "192.168.1.50", port: 8765, hosts: ["192.168.1.50"], ...overrides }
}

/** Deferred promise so a test can control exactly when a mocked invoke call resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface FakeAndroidNsd {
  isSupported: () => boolean
  startDiscovery: () => void
  stopDiscovery: () => void
  drainDiscovered: () => string
  queue: DiscoveredReceiver[]
}

function installFakeAndroidNsd(): FakeAndroidNsd {
  const bridge: FakeAndroidNsd = {
    isSupported: () => true,
    startDiscovery: () => {},
    stopDiscovery: () => {},
    queue: [],
    drainDiscovered: () => {
      const drained = bridge.queue
      bridge.queue = []
      return JSON.stringify(drained)
    },
  }
  window.AndroidNsd = bridge
  return bridge
}

beforeEach(() => {
  vi.useFakeTimers()
  invokeMock.mockReset()
  window.__TAURI_INTERNALS__ = true
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete window.AndroidNsd
  delete window.__TAURI_INTERNALS__
})

describe("discoverReceivers (android-nsd)", () => {
  it("starts the subnet sweep after the grace period when NSD has found nothing yet", async () => {
    installFakeAndroidNsd()
    invokeMock.mockResolvedValue([makeReceiver({ name: "Swept TV", host: "10.0.0.9", port: 8765 })])

    const onFound = vi.fn()
    const onDone = vi.fn()
    discoverReceivers(onFound, 5000, onDone)

    await vi.advanceTimersByTimeAsync(1199)
    expect(invokeMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(50)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith("receiver_discover", {})

    await vi.advanceTimersByTimeAsync(0)
    expect(onFound).toHaveBeenCalledWith([expect.objectContaining({ name: "Swept TV" })])
  })

  it("skips the subnet sweep when NSD already found a receiver during the grace period", async () => {
    const nsd = installFakeAndroidNsd()
    invokeMock.mockResolvedValue([])

    const onFound = vi.fn()
    discoverReceivers(onFound, 5000)

    nsd.queue.push(makeReceiver())
    await vi.advanceTimersByTimeAsync(700) // one poll tick drains the queued receiver
    expect(onFound).toHaveBeenCalledWith([expect.objectContaining({ host: "192.168.1.50" })])

    await vi.advanceTimersByTimeAsync(5000)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("fires onDone at the requested timeout without waiting for a still-running sweep", async () => {
    installFakeAndroidNsd()
    const sweep = deferred<DiscoveredReceiver[]>()
    invokeMock.mockReturnValue(sweep.promise)

    const onFound = vi.fn()
    const onDone = vi.fn()
    discoverReceivers(onFound, 3000, onDone)

    await vi.advanceTimersByTimeAsync(3000)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onFound).not.toHaveBeenCalled()

    sweep.resolve([makeReceiver({ name: "Late TV" })])
    await vi.advanceTimersByTimeAsync(0)
    expect(onFound).toHaveBeenCalledWith([expect.objectContaining({ name: "Late TV" })])
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("shares one in-flight sweep across a Rescan instead of launching a second Rust invoke", async () => {
    installFakeAndroidNsd()
    const sweep = deferred<DiscoveredReceiver[]>()
    invokeMock.mockReturnValue(sweep.promise)

    const firstOnFound = vi.fn()
    const firstOnDone = vi.fn()
    const cancelFirst = discoverReceivers(firstOnFound, 5000, firstOnDone)

    await vi.advanceTimersByTimeAsync(1250) // first scan's grace period elapses, sweep starts
    expect(invokeMock).toHaveBeenCalledTimes(1)

    cancelFirst()

    const secondOnFound = vi.fn()
    const secondOnDone = vi.fn()
    discoverReceivers(secondOnFound, 5000, secondOnDone)

    await vi.advanceTimersByTimeAsync(1250) // second scan's grace period elapses too
    expect(invokeMock).toHaveBeenCalledTimes(1) // still just the one shared invoke

    sweep.resolve([makeReceiver({ name: "Shared Result" })])
    await vi.advanceTimersByTimeAsync(0)

    expect(firstOnFound).not.toHaveBeenCalled()
    expect(secondOnFound).toHaveBeenCalledWith([expect.objectContaining({ name: "Shared Result" })])
  })
})
