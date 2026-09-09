// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mountMpvControls } from "../src/scripts/lib/mpv-controls"

function makeHandle() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const state = { paused: false, webFullscreen: false }
  const handle = {
    state,
    emit(event: string, ...args: unknown[]) {
      for (const fn of Array.from(listeners.get(event) ?? [])) fn(...args)
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(fn)
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn)
    },
    src() {},
    play: vi.fn(() => {
      state.paused = false
    }),
    pause: vi.fn(() => {
      state.paused = true
    }),
    paused: () => state.paused,
    duration: () => NaN,
    currentTime: () => 0,
    volume: () => 1,
    muted: () => false,
    isLive: () => true,
    requestWebFullscreen() {
      state.webFullscreen = true
      handle.emit("webfullscreenchange")
    },
    exitWebFullscreen() {
      state.webFullscreen = false
      handle.emit("webfullscreenchange")
    },
    isWebFullscreen: () => state.webFullscreen,
  }
  return handle
}

describe("mpv control bar auto-hide", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("hides after the inactivity window", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const handle = makeHandle()
    const teardown = mountMpvControls(container, handle as never)
    const bar = container.querySelector<HTMLElement>(".mpv-controls")!
    expect(bar.dataset.visible).toBe("true")
    vi.advanceTimersByTime(3500)
    expect(bar.dataset.visible).toBe("false")
    teardown()
  })

  it("re-hides after a useractive pulse stops", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const handle = makeHandle()
    const teardown = mountMpvControls(container, handle as never)
    const bar = container.querySelector<HTMLElement>(".mpv-controls")!
    // player-focus-keeper pulses true every 1500ms while focus sits in the player container.
    for (let i = 0; i < 4; i++) {
      handle.emit("useractive", true)
      vi.advanceTimersByTime(1500)
      expect(bar.dataset.visible).toBe("true")
    }
    vi.advanceTimersByTime(3500)
    expect(bar.dataset.visible).toBe("false")
    teardown()
  })

  it("keeps the bar up while the settings popover is open", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const handle = makeHandle()
    const teardown = mountMpvControls(container, handle as never)
    const bar = container.querySelector<HTMLElement>(".mpv-controls")!
    bar.querySelector<HTMLButtonElement>('[data-role="settings"]')!.click()
    vi.advanceTimersByTime(5000)
    expect(bar.dataset.visible).toBe("true")
    bar.querySelector<HTMLButtonElement>('[data-role="settings"]')!.click()
    vi.advanceTimersByTime(3500)
    expect(bar.dataset.visible).toBe("false")
    teardown()
  })

  it("does not pin on pointer-driven focus of a bar control", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const handle = makeHandle()
    const teardown = mountMpvControls(container, handle as never)
    const bar = container.querySelector<HTMLElement>(".mpv-controls")!
    bar.querySelector<HTMLButtonElement>('[data-role="mute"]')!.focus()
    vi.advanceTimersByTime(3500)
    expect(bar.dataset.visible).toBe("false")
    teardown()
  })
})

describe("mpv control bar web fullscreen", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ""
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it("does not toggle playback when a bar button re-renders its own icon", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const handle = makeHandle()
    const teardown = mountMpvControls(container, handle as never)
    const bar = container.querySelector<HTMLElement>(".mpv-controls")!
    const button = bar.querySelector<HTMLButtonElement>('[data-role="web-fullscreen"]')!
    // The icon swap detaches the clicked <svg>, so the container can no longer see it inside the bar.
    button.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    vi.advanceTimersByTime(1000)
    expect(handle.state.webFullscreen).toBe(true)
    expect(handle.pause).not.toHaveBeenCalled()
    teardown()
  })

  it("mounts a Tauri drag strip only while web fullscreen is active", () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    const container = document.createElement("div")
    document.body.appendChild(container)
    const handle = makeHandle()
    const teardown = mountMpvControls(container, handle as never)
    const stripSelector = '[data-role="web-fullscreen-drag"]'
    expect(container.querySelector(stripSelector)).toBeNull()
    handle.requestWebFullscreen()
    const strip = container.querySelector<HTMLElement>(stripSelector)!
    expect(strip.hasAttribute("data-tauri-drag-region")).toBe(true)
    handle.exitWebFullscreen()
    expect(container.querySelector(stripSelector)).toBeNull()
    handle.requestWebFullscreen()
    expect(container.querySelector(stripSelector)).not.toBeNull()
    teardown()
    expect(container.querySelector(stripSelector)).toBeNull()
  })

  it("keeps the drag strip out of the play/pause and fullscreen click targets", () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    const container = document.createElement("div")
    document.body.appendChild(container)
    const handle = makeHandle()
    const teardown = mountMpvControls(container, handle as never)
    handle.requestWebFullscreen()
    const strip = container.querySelector<HTMLElement>('[data-role="web-fullscreen-drag"]')!
    strip.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    strip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    vi.advanceTimersByTime(1000)
    expect(handle.pause).not.toHaveBeenCalled()
    expect(handle.state.webFullscreen).toBe(true)
    teardown()
  })

  it("skips the drag strip outside Tauri", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const handle = makeHandle()
    const teardown = mountMpvControls(container, handle as never)
    handle.requestWebFullscreen()
    expect(container.querySelector('[data-role="web-fullscreen-drag"]')).toBeNull()
    teardown()
  })
})
