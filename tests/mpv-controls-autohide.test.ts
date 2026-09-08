// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mountMpvControls } from "../src/scripts/lib/mpv-controls"

function makeHandle() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
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
    play() {},
    pause() {},
    paused: () => false,
    duration: () => NaN,
    currentTime: () => 0,
    volume: () => 1,
    muted: () => false,
    isLive: () => true,
  }
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
