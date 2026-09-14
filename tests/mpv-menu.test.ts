import { describe, it, expect } from "vitest"
import {
  buildMpvMenu,
  toLegacyMpvMenuData,
  parseMpvMenuMessageId,
  PLAYBACK_RATES,
  formatPlaybackRate,
  type MpvMenuPick,
} from "../src/scripts/lib/mpv-menu"

function idsOf(items: ReturnType<typeof buildMpvMenu>["items"]): number[] {
  const ids: number[] = []
  for (const item of items) {
    if (item.id != null) ids.push(item.id)
    if (item.submenu) ids.push(...idsOf(item.submenu))
  }
  return ids
}

describe("buildMpvMenu audio", () => {
  it("starts with a title then a separator", () => {
    const { items } = buildMpvMenu("audio", { tracks: [] })
    expect(items[0].kind).toBe("title")
    expect(items[0].title).toBe("Audio")
    expect(items[1].kind).toBe("separator")
  })

  it("builds one radio item per track, checked on the active track", () => {
    const { items, picks } = buildMpvMenu("audio", {
      tracks: [
        { id: 1, label: "English", active: false },
        { id: 2, label: "German", active: true },
      ],
    })
    const [english, german] = items.slice(2)
    expect(english).toMatchObject({ kind: "radio", title: "English", checked: false })
    expect(german).toMatchObject({ kind: "radio", title: "German", checked: true })
    expect(picks.get(english.id!)).toEqual({ kind: "audio", id: 1 })
    expect(picks.get(german.id!)).toEqual({ kind: "audio", id: 2 })
  })
})

describe("buildMpvMenu subtitles", () => {
  it("leads the choices with a checked, disabled Off item when there are zero tracks", () => {
    const { items, picks } = buildMpvMenu("subtitles", { tracks: [] })
    const off = items[2]
    expect(off).toMatchObject({ kind: "radio", title: "Off", checked: true, disabled: true })
    expect(picks.get(off.id!)).toEqual({ kind: "subtitle", id: null })
    // Still reachable with zero tracks: separator + "Load subtitle file…".
    expect(items[3]).toEqual({ kind: "separator" })
    expect(items[4].kind).toBe("item")
    expect(items[4].title).toBe("Load subtitle file…")
  })

  it("checks the active track instead of Off when one is selected, and Off is not disabled", () => {
    const { items } = buildMpvMenu("subtitles", { tracks: [{ id: 3, label: "German", active: true }] })
    const off = items[2]
    const german = items[3]
    expect(off).toMatchObject({ checked: false, disabled: false })
    expect(german).toMatchObject({ kind: "radio", title: "German", checked: true })
  })

  it("appends a separator and a Load subtitle file entry after any tracks", () => {
    const { items } = buildMpvMenu("subtitles", { tracks: [{ id: 1, label: "English", active: false }] })
    expect(items[4]).toEqual({ kind: "separator" })
    expect(items[5].title).toBe("Load subtitle file…")
  })
})

describe("buildMpvMenu speed", () => {
  it("offers one radio per playback rate, checked on the current rate", () => {
    const { items } = buildMpvMenu("speed", { currentRate: 1.5 })
    const rates = items.slice(2)
    expect(rates).toHaveLength(PLAYBACK_RATES.length)
    const checked = rates.find((item) => item.checked)
    expect(checked?.title).toBe(formatPlaybackRate(1.5))
  })
})

describe("buildMpvMenu subtitleDelay / audioDelay", () => {
  it("shows the current value in the title and offers the fixed step set plus Reset", () => {
    const { items, picks } = buildMpvMenu("subtitleDelay", { currentSeconds: 0.25 })
    expect(items[0]).toEqual({ kind: "title", title: "Subtitle delay +250 ms" })
    expect(items[1]).toEqual({ kind: "separator" })
    const steps = items.slice(2, 8)
    expect(steps.map((item) => item.title)).toEqual(["-500 ms", "-250 ms", "-100 ms", "+100 ms", "+250 ms", "+500 ms"])
    expect(items[8]).toEqual({ kind: "separator" })
    expect(items[9].title).toBe("Reset")
    expect(picks.get(steps[0].id!)).toEqual({ kind: "subtitle-delay-step", deltaMs: -500 })
    expect(picks.get(items[9].id!)).toEqual({ kind: "subtitle-delay-reset" })
  })

  it("uses the audio-delay title and pick kinds for the audioDelay menu", () => {
    const { items, picks } = buildMpvMenu("audioDelay", { currentSeconds: -0.1 })
    expect(items[0]).toEqual({ kind: "title", title: "Audio delay -100 ms" })
    const firstStep = items[2]
    expect(picks.get(firstStep.id!)).toEqual({ kind: "audio-delay-step", deltaMs: -500 })
    expect(picks.get(items[9].id!)).toEqual({ kind: "audio-delay-reset" })
  })
})

describe("buildMpvMenu subtitleStyle", () => {
  it("nests Size/Position/Colour submenus and appends Reset", () => {
    const { items, picks } = buildMpvMenu("subtitleStyle", {
      style: { size: "large", position: "raised", color: "yellow" },
    })
    const [sizeMenu, positionMenu, colorMenu] = items.slice(2, 5)
    expect(sizeMenu).toMatchObject({ kind: "submenu", title: "Size" })
    expect(positionMenu).toMatchObject({ kind: "submenu", title: "Position" })
    expect(colorMenu).toMatchObject({ kind: "submenu", title: "Colour" })
    const checkedSize = sizeMenu.submenu!.find((item) => item.checked)
    expect(checkedSize?.title).toBe("Large")
    expect(picks.get(checkedSize!.id!)).toEqual({ kind: "subtitle-style-size", size: "large" })
    expect(items[5]).toEqual({ kind: "separator" })
    expect(items[6].title).toBe("Reset")
    expect(picks.get(items[6].id!)).toEqual({ kind: "subtitle-style-reset" })
  })
})

describe("buildMpvMenu root", () => {
  const baseModel = {
    audioTracks: [] as { id: number; label: string; active: boolean }[],
    subtitleTracks: [] as { id: number; label: string; active: boolean }[],
    currentRate: 1,
    subtitleDelaySeconds: 0,
    audioDelaySeconds: 0,
    subtitleStyle: { size: "normal", position: "bottom", color: "white" } as const,
  }

  it("starts with a title then a separator", () => {
    const { items } = buildMpvMenu("root", baseModel)
    expect(items[0]).toEqual({ kind: "title", title: "Settings" })
    expect(items[1]).toEqual({ kind: "separator" })
  })

  it("hides the Audio submenu with zero audio tracks, but always keeps Subtitles", () => {
    const { items } = buildMpvMenu("root", baseModel)
    const titles = items.slice(2).map((item) => item.title)
    expect(titles).not.toContain("Audio")
    expect(titles).toContain("Subtitles")
  })

  it("shows the Audio submenu once there are audio tracks", () => {
    const { items } = buildMpvMenu("root", {
      ...baseModel,
      audioTracks: [{ id: 1, label: "English", active: true }],
    })
    const titles = items.slice(2).map((item) => item.title)
    expect(titles).toContain("Audio")
  })

  it("lists all six submenus when tracks are present", () => {
    const { items } = buildMpvMenu("root", {
      ...baseModel,
      audioTracks: [{ id: 1, label: "English", active: true }],
    })
    const titles = items.slice(2).map((item) => item.title)
    expect(titles).toEqual(["Audio", "Subtitles", "Playback speed", "Subtitle delay", "Audio delay", "Subtitle style"])
  })
})

describe("id assignment", () => {
  it("assigns unique, positive, sequential ids across a whole menu including submenus", () => {
    const { items } = buildMpvMenu("root", {
      audioTracks: [{ id: 1, label: "English", active: true }],
      subtitleTracks: [{ id: 2, label: "German", active: false }],
      currentRate: 1,
      subtitleDelaySeconds: 0,
      audioDelaySeconds: 0,
      subtitleStyle: { size: "normal", position: "bottom", color: "white" },
    })
    const ids = idsOf(items)
    expect(ids.every((id) => id > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })
})

describe("toLegacyMpvMenuData / parseMpvMenuMessageId", () => {
  it("converts separators, titles and radios into mpv's menu-data shape", () => {
    const { items } = buildMpvMenu("speed", { currentRate: 1 })
    const legacy = toLegacyMpvMenuData(items)
    expect(legacy[0]).toEqual({ type: "", title: "Playback speed", state: ["disabled"] })
    expect(legacy[1]).toEqual({ type: "separator" })
    const checked = legacy.slice(2).find((item) => item.state?.includes("checked"))
    expect(checked?.title).toBe(formatPlaybackRate(1))
    expect(checked?.cmd).toMatch(/^script-message xt-menu pick:\d+$/)
  })

  it("round-trips a picked id back out of a client-message's args", () => {
    const { items, picks } = buildMpvMenu("speed", { currentRate: 1 })
    const legacy = toLegacyMpvMenuData(items)
    const target = legacy.find((item) => item.cmd)!
    const id = Number(/pick:(\d+)/.exec(target.cmd!)![1])
    const messageValue = target.cmd!.replace("script-message ", "")
    const pickedId = parseMpvMenuMessageId(messageValue.split(" "))
    expect(pickedId).toBe(id)
    const pick = picks.get(pickedId!) as MpvMenuPick
    expect(pick.kind).toBe("speed")
  })

  it("ignores foreign client-message args", () => {
    expect(parseMpvMenuMessageId(["some-other-script", "pick:1"])).toBeNull()
    expect(parseMpvMenuMessageId(["xt-menu"])).toBeNull()
    expect(parseMpvMenuMessageId([])).toBeNull()
    expect(parseMpvMenuMessageId(["xt-menu", "not-a-pick"])).toBeNull()
  })
})
