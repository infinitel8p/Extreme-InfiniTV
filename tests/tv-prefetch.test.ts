/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { neighboursOf, warmImageUrl } from "../src/scripts/tv/prefetch"

function buildCardTrack(count: number): { track: HTMLElement; cards: HTMLElement[] } {
  const track = document.createElement("div")
  const cards: HTMLElement[] = []
  for (let i = 0; i < count; i++) {
    const card = document.createElement("a")
    card.dataset.focusKey = `card-${i}`
    track.appendChild(card)
    cards.push(card)
  }
  return { track, cards }
}

describe("neighboursOf", () => {
  it("returns the closest siblings first on both sides", () => {
    const { track, cards } = buildCardTrack(7)
    const neighbours = neighboursOf(track, cards[3], 2)
    expect(neighbours.map((el) => el.dataset.focusKey)).toEqual(["card-2", "card-4", "card-1", "card-5"])
  })

  it("clamps at the start of the track", () => {
    const { track, cards } = buildCardTrack(5)
    const neighbours = neighboursOf(track, cards[0], 2)
    expect(neighbours.map((el) => el.dataset.focusKey)).toEqual(["card-1", "card-2"])
  })

  it("clamps at the end of the track", () => {
    const { track, cards } = buildCardTrack(5)
    const neighbours = neighboursOf(track, cards[4], 2)
    expect(neighbours.map((el) => el.dataset.focusKey)).toEqual(["card-3", "card-2"])
  })

  it("returns nothing when the focused element isn't in the container", () => {
    const { track } = buildCardTrack(3)
    const detached = document.createElement("a")
    detached.dataset.focusKey = "outside"
    expect(neighboursOf(track, detached, 2)).toEqual([])
  })
})

class MockImage {
  static instances: MockImage[] = []
  decoding = ""
  src = ""
  constructor() {
    MockImage.instances.push(this)
  }
}

describe("warmImageUrl", () => {
  beforeEach(() => {
    MockImage.instances = []
    vi.stubGlobal("Image", MockImage)
    vi.stubGlobal("navigator", { connection: undefined })
  })

  it("warms an unseen url exactly once", () => {
    warmImageUrl("https://example.com/a.jpg")
    warmImageUrl("https://example.com/a.jpg")
    expect(MockImage.instances).toHaveLength(1)
    expect(MockImage.instances[0].src).toBe("https://example.com/a.jpg")
  })

  it("skips a null or empty url", () => {
    warmImageUrl(null)
    warmImageUrl(undefined)
    warmImageUrl("")
    expect(MockImage.instances).toHaveLength(0)
  })

  it("skips warming when the connection reports saveData", () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } })
    warmImageUrl("https://example.com/save-data.jpg")
    expect(MockImage.instances).toHaveLength(0)
  })
})
