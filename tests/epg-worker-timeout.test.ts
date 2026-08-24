/**
 * @vitest-environment jsdom
 */
// A worker killed without firing "error" used to leave the parse pending forever, so the EPG
// never loaded and nothing was logged.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// parseXmlTv keeps only programmes inside [now - past window, now + 36h], so stamp from now.
function xmltvStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
  )
}

function fixtureXml(): string {
  const start = new Date(Date.now() + 60 * 60 * 1000)
  const stop = new Date(Date.now() + 2 * 60 * 60 * 1000)
  return `<?xml version="1.0"?><tv>
  <channel id="c1"><display-name>One</display-name></channel>
  <programme start="${xmltvStamp(start)}" stop="${xmltvStamp(stop)}" channel="c1">
    <title>Show</title>
  </programme>
</tv>`
}

const XML = fixtureXml()

class SilentWorker {
  postMessage(): void {}
  addEventListener(): void {}
  terminate(): void {}
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { Worker?: unknown }).Worker
})

describe("xmlWorkerTimeoutMs", () => {
  it("gives a small feed the floor budget", async () => {
    const { xmlWorkerTimeoutMs } = await import("../src/scripts/lib/epg-data.js")
    expect(xmlWorkerTimeoutMs(0)).toBe(20_000)
    expect(xmlWorkerTimeoutMs(1024)).toBe(24_000)
  })

  it("scales with feed size so a big EPG on a slow device is not cut off early", async () => {
    const { xmlWorkerTimeoutMs } = await import("../src/scripts/lib/epg-data.js")
    expect(xmlWorkerTimeoutMs(10 * 1024 * 1024)).toBe(60_000)
    expect(xmlWorkerTimeoutMs(50 * 1024 * 1024)).toBe(220_000)
  })

  it("treats junk input as the floor rather than NaN", async () => {
    const { xmlWorkerTimeoutMs } = await import("../src/scripts/lib/epg-data.js")
    expect(xmlWorkerTimeoutMs(undefined as unknown as number)).toBe(20_000)
    expect(xmlWorkerTimeoutMs(-5)).toBe(20_000)
  })
})

describe("parseXmlTvOffMain", () => {
  it("falls back to the main thread when the worker never replies", async () => {
    ;(globalThis as { Worker?: unknown }).Worker = SilentWorker
    vi.useFakeTimers()

    const { parseXmlTvOffMain, xmlWorkerTimeoutMs } = await import("../src/scripts/lib/epg-data.js")
    const pending = parseXmlTvOffMain(XML)
    await vi.advanceTimersByTimeAsync(xmlWorkerTimeoutMs(XML.length) + 1)
    const parsed = await pending

    expect(parsed.programmes.get("c1")).toHaveLength(1)
    expect(parsed.channelNames.get("c1")).toBe("One")
  })

  it("parses on the main thread when the environment has no Worker at all", async () => {
    const { parseXmlTvOffMain } = await import("../src/scripts/lib/epg-data.js")
    const parsed = await parseXmlTvOffMain(XML)
    expect(parsed.programmes.get("c1")).toHaveLength(1)
  })
})

describe("a wedged worker is retired", () => {
  it("does not pay the timeout budget again on the next parse", async () => {
    let constructed = 0
    class CountingSilentWorker extends SilentWorker {
      constructor() {
        super()
        constructed++
      }
    }
    ;(globalThis as { Worker?: unknown }).Worker = CountingSilentWorker
    vi.useFakeTimers()

    const { parseXmlTvOffMain, xmlWorkerTimeoutMs } = await import("../src/scripts/lib/epg-data.js")
    const first = parseXmlTvOffMain(XML)
    await vi.advanceTimersByTimeAsync(xmlWorkerTimeoutMs(XML.length) + 1)
    await first
    expect(constructed).toBe(1)

    const second = await parseXmlTvOffMain(XML)
    expect(constructed).toBe(1)
    expect(second.programmes.get("c1")).toHaveLength(1)
  })
})
