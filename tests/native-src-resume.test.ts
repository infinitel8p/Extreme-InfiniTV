/**
 * @vitest-environment jsdom
 *
 * Replacing video.src fires abort+emptied, resetting the element to paused and
 * rejecting the in-flight play(); setNativeSrc must resume once the new source
 * is ready. Verified against real WebKit; these pin the branch logic.
 */
import { describe, it, expect, vi } from "vitest"
import { setNativeSrc } from "../src/scripts/lib/player-runtime"

function makeVideo(): { el: HTMLVideoElement; play: ReturnType<typeof vi.fn> } {
  const el = document.createElement("video")
  const play = vi.fn(() => Promise.resolve())
  // jsdom has no media stack, so play() is not implemented there.
  Object.defineProperty(el, "play", { value: play, writable: true })
  return { el, play }
}

describe("setNativeSrc", () => {
  it("assigns the source", () => {
    const { el } = makeVideo()
    setNativeSrc(el, "http://host/live/u/p/1.m3u8")
    expect(el.getAttribute("src")).toBe("http://host/live/u/p/1.m3u8")
  })

  it("does not re-issue play on a first load (nothing was interrupted)", () => {
    const { el, play } = makeVideo()
    setNativeSrc(el, "http://host/live/u/p/1.m3u8")
    el.dispatchEvent(new Event("canplay"))
    expect(play).not.toHaveBeenCalled()
  })

  it("re-issues play once the replacement source is ready", () => {
    const { el, play } = makeVideo()
    el.setAttribute("src", "http://host/live/u/p/1.m3u8")
    setNativeSrc(el, "http://host/live/u/p/2.m3u8")
    expect(play).not.toHaveBeenCalled()   // not before the new source is ready
    el.dispatchEvent(new Event("canplay"))
    expect(play).toHaveBeenCalledTimes(1)
  })

  it("only resumes once, so later canplay events do not fight the user", () => {
    const { el, play } = makeVideo()
    el.setAttribute("src", "http://host/live/u/p/1.m3u8")
    setNativeSrc(el, "http://host/live/u/p/2.m3u8")
    el.dispatchEvent(new Event("canplay"))
    el.dispatchEvent(new Event("canplay"))
    el.dispatchEvent(new Event("canplay"))
    expect(play).toHaveBeenCalledTimes(1)
  })

  it("survives a rejected play promise", () => {
    const el = document.createElement("video")
    const play = vi.fn(() => Promise.reject(new Error("NotAllowedError")))
    Object.defineProperty(el, "play", { value: play, writable: true })
    el.setAttribute("src", "http://host/live/u/p/1.m3u8")
    setNativeSrc(el, "http://host/live/u/p/2.m3u8")
    expect(() => el.dispatchEvent(new Event("canplay"))).not.toThrow()
    expect(play).toHaveBeenCalledTimes(1)
  })

  it("tolerates a missing play() implementation", () => {
    const el = document.createElement("video")
    Object.defineProperty(el, "play", { value: undefined, writable: true })
    el.setAttribute("src", "http://host/live/u/p/1.m3u8")
    setNativeSrc(el, "http://host/live/u/p/2.m3u8")
    expect(() => el.dispatchEvent(new Event("canplay"))).not.toThrow()
  })

  it("the emptied fired by this very assignment does not cancel the resume", async () => {
    const { el, play } = makeVideo()
    el.setAttribute("src", "http://host/live/u/p/1.m3u8")
    setNativeSrc(el, "http://host/live/u/p/2.m3u8")
    // Real elements fire emptied synchronously-ish as part of this load; the
    // cancel guard is registered a tick later precisely so it is not consumed here.
    el.dispatchEvent(new Event("emptied"))
    el.dispatchEvent(new Event("canplay"))
    expect(play).toHaveBeenCalledTimes(1)
  })

  it("a superseding swap cancels the previous pending resume", async () => {
    const { el, play } = makeVideo()
    el.setAttribute("src", "http://host/live/u/p/1.m3u8")
    setNativeSrc(el, "http://host/live/u/p/2.m3u8")
    await new Promise((resolve) => setTimeout(resolve, 0))   // let the cancel guard arm
    // A newer tune replaces the source again; it arms its own resume.
    setNativeSrc(el, "http://host/live/u/p/3.m3u8")
    el.dispatchEvent(new Event("emptied"))
    el.dispatchEvent(new Event("canplay"))
    // Exactly one resume, from the newest swap - not one per stale listener.
    expect(play).toHaveBeenCalledTimes(1)
    expect(el.getAttribute("src")).toBe("http://host/live/u/p/3.m3u8")
  })
})
