/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Stable spy identities: the mocked view modules wrap these directly, so clearing them
// in beforeEach gives a clean per-test call count regardless of module-cache re-use.
const { motionState, moviesPrepaint, downloadsPrepaint, homeMount } = vi.hoisted(() => ({
  motionState: { lite: false },
  moviesPrepaint: vi.fn(() => true),
  downloadsPrepaint: vi.fn(() => true),
  homeMount: vi.fn(() => () => {}),
}))

vi.mock("@/scripts/tv/motion", () => ({
  beginNavigationTransition: vi.fn(),
  endNavigationTransition: vi.fn(),
  memoryConservative: () => motionState.lite,
}))
vi.mock("@/scripts/lib/img-cache.ts", () => ({ releaseCachedImages: vi.fn() }))
vi.mock("@/scripts/tv/views/home", () => ({ default: { mount: homeMount } }))
vi.mock("@/scripts/tv/views/movies", () => ({ default: { mount: vi.fn(() => () => {}), prepaint: moviesPrepaint } }))
vi.mock("@/scripts/tv/views/downloads", () => ({
  default: { mount: vi.fn(() => () => {}), prepaint: downloadsPrepaint },
}))
vi.mock("@/scripts/tv/views/series", () => ({ default: { mount: vi.fn(() => () => {}) } }))
vi.mock("@/scripts/tv/views/search", () => ({ default: { mount: vi.fn(() => () => {}) } }))
vi.mock("@/scripts/tv/views/movies-detail", () => ({ default: { mount: vi.fn(() => () => {}) } }))
vi.mock("@/scripts/tv/views/series-detail", () => ({ default: { mount: vi.fn(() => () => {}) } }))

type IdleCallback = () => void

function stubRequestIdleCallback(): { spy: ReturnType<typeof vi.fn>; run: () => void; runPending: () => void } {
  const queue: IdleCallback[] = []
  const spy = vi.fn((cb: IdleCallback) => {
    queue.push(cb)
    return queue.length
  })
  vi.stubGlobal("requestIdleCallback", spy)
  return {
    spy,
    run: () => {
      const cb = queue.shift()
      cb?.()
    },
    // Background warmup and a link-focus preload share the same idle queue, so a link's
    // callback isn't necessarily first in line - drain everything currently queued.
    // Capped so a scheduling bug surfaces as a failing assertion, not a hung test run.
    runPending: () => {
      let guard = 0
      while (queue.length && guard++ < 50) queue.shift()?.()
    },
  }
}

// A mocked dynamic import still resolves through Vite's SSR module runner, which needs a
// real macrotask tick (not just queued microtasks) to settle.
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** Reads resolvedViewModules' state indirectly through the router's own synchronous prepaint path. */
function dispatchSwapTo(view: string): void {
  const main = document.getElementById("tv-main") as HTMLElement
  main.dataset.tvView = view
  document.dispatchEvent(new Event("astro:after-swap"))
}

// mountTvRouter() has no matching unmount, so a fresh router instance per test (via
// vi.resetModules()) would otherwise leave the previous instance's document/window listeners
// attached - each still firing against its own now-stale `resolvedViewModules` closure.
type ListenerEntry = [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]

describe("tv/router.ts warmup + link preload scheduling", () => {
  let clock = 0
  let addedDocListeners: ListenerEntry[] = []
  let addedWindowListeners: ListenerEntry[] = []

  beforeEach(() => {
    vi.resetModules()
    document.body.innerHTML = ""
    motionState.lite = false
    moviesPrepaint.mockClear()
    downloadsPrepaint.mockClear()
    homeMount.mockClear()
    clock = 0
    vi.spyOn(performance, "now").mockImplementation(() => clock)

    addedDocListeners = []
    addedWindowListeners = []
    const originalDocAdd = document.addEventListener.bind(document)
    vi.spyOn(document, "addEventListener").mockImplementation((...args: ListenerEntry) => {
      addedDocListeners.push(args)
      return originalDocAdd(...args)
    })
    const originalWindowAdd = window.addEventListener.bind(window)
    vi.spyOn(window, "addEventListener").mockImplementation((...args: ListenerEntry) => {
      addedWindowListeners.push(args)
      return originalWindowAdd(...args)
    })
  })

  afterEach(() => {
    for (const [type, listener, options] of addedDocListeners) document.removeEventListener(type, listener, options)
    for (const [type, listener, options] of addedWindowListeners) window.removeEventListener(type, listener, options)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function bootWithHomeMounted(): Promise<void> {
    document.body.innerHTML = `<div id="tv-main" data-tv-view="home"><div data-tv-view-root></div></div>`
    const { mountTvRouter } = await import("@/scripts/tv/router")
    mountTvRouter()
    document.dispatchEvent(new Event("astro:page-load"))
    await flushAsync()
  }

  it("defers a focused link's view-module import to idle time instead of importing it synchronously", async () => {
    const idle = stubRequestIdleCallback()
    await bootWithHomeMounted()

    document.body.innerHTML += `<a id="link" href="/tv/downloads" tabindex="0">Downloads</a>`
    const link = document.getElementById("link") as HTMLAnchorElement
    link.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))

    // Scheduled, not yet imported: a prepaint attempt right now must find nothing resolved.
    dispatchSwapTo("downloads")
    expect(downloadsPrepaint).not.toHaveBeenCalled()

    // Background warmup's own idle slot (queued by bootWithHomeMounted) sits ahead of this
    // link's callback in the same queue - drain both.
    idle.runPending()
    await flushAsync()

    dispatchSwapTo("downloads")
    expect(downloadsPrepaint).toHaveBeenCalledTimes(1)
  })

  it("memoizes a link's href so refocusing it costs a Set lookup, not a second import schedule", async () => {
    const idle = stubRequestIdleCallback()
    await bootWithHomeMounted()
    const scheduledAfterBoot = idle.spy.mock.calls.length

    document.body.innerHTML += `<a id="link" href="/tv/downloads" tabindex="0">Downloads</a>`
    const link = document.getElementById("link") as HTMLAnchorElement
    link.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
    link.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
    link.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))

    expect(idle.spy.mock.calls.length).toBe(scheduledAfterBoot + 1)
  })

  it("bails before scheduling anything once the view module is already resolved", async () => {
    const idle = stubRequestIdleCallback()
    await bootWithHomeMounted()

    document.body.innerHTML += `<a id="link" href="/tv/downloads" tabindex="0">Downloads</a>`
    const link = document.getElementById("link") as HTMLAnchorElement
    link.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
    idle.runPending()
    await flushAsync()
    dispatchSwapTo("downloads")
    expect(downloadsPrepaint).toHaveBeenCalledTimes(1)
    const scheduledSoFar = idle.spy.mock.calls.length

    // A different href for the same already-resolved view (trailing slash) must not
    // schedule a second import.
    document.body.innerHTML += `<a id="link2" href="/tv/downloads/" tabindex="0">Downloads again</a>`
    const link2 = document.getElementById("link2") as HTMLAnchorElement
    link2.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
    expect(idle.spy.mock.calls.length).toBe(scheduledSoFar)
  })

  it("omits the idle timeout on the memory-conservative tier", async () => {
    motionState.lite = true
    const idle = stubRequestIdleCallback()
    await bootWithHomeMounted()

    expect(idle.spy).toHaveBeenCalledTimes(1)
    expect(idle.spy.mock.calls[0][1]).toBeUndefined()
  })

  it("uses an 8s idle timeout off the memory-conservative tier", async () => {
    motionState.lite = false
    const idle = stubRequestIdleCallback()
    await bootWithHomeMounted()

    expect(idle.spy).toHaveBeenCalledTimes(1)
    expect(idle.spy.mock.calls[0][1]).toEqual({ timeout: 8000 })
  })

  it("re-defers background warmup while input is hot instead of importing mid-keypress", async () => {
    const idle = stubRequestIdleCallback()
    await bootWithHomeMounted()

    // Background warmup's first idle slot is queued after the home view mounts.
    expect(idle.spy).toHaveBeenCalledTimes(1)

    clock = 100
    window.dispatchEvent(new KeyboardEvent("keydown"))

    // Still well within the 500ms hot-input window: re-defer, no import.
    idle.run()
    dispatchSwapTo("movies")
    expect(moviesPrepaint).not.toHaveBeenCalled()
    expect(idle.spy).toHaveBeenCalledTimes(2)

    // Input has cooled down: the deferred warmup now actually imports.
    clock = 700
    idle.run()
    await flushAsync()
    dispatchSwapTo("movies")
    expect(moviesPrepaint).toHaveBeenCalledTimes(1)
    expect(idle.spy).toHaveBeenCalledTimes(3)
  })
})
