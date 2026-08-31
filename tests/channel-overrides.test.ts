import { describe, it, expect } from "vitest"
import {
  channelOverrideKey,
  overrideIdentity,
  hasVisibleOverride,
  applyChannelOverrides,
  stripAffix,
  planAffixStrip,
  resolveOverrideKey,
  sanitizeOverrideName,
  sanitizeOverrideLogo,
  sanitizeOverrideChno,
  MAX_OVERRIDE_NAME_LENGTH,
  MAX_OVERRIDE_LOGO_LENGTH,
  MAX_OVERRIDE_CHNO,
  type ChannelOverrideMap,
} from "@/scripts/lib/channel-overrides.ts"
import { normalize } from "@/scripts/lib/text.ts"

const xtreamChannel = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Channel ${id}`,
  category: "Sports",
  logo: null,
  ...extra,
})

const m3uChannel = (id: number, url: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Channel ${id}`,
  category: "Sports",
  logo: null,
  url,
  ...extra,
})

describe("channelOverrideKey", () => {
  it("keys an Xtream channel on its provider stream id", () => {
    expect(channelOverrideKey(xtreamChannel(4242), false)).toBe("x:4242")
  })

  it("keys an M3U channel on its URL, never its positional id", () => {
    const first = channelOverrideKey(m3uChannel(1, "http://h/live/u/p/9.ts"), true)
    const shifted = channelOverrideKey(m3uChannel(7, "http://h/live/u/p/9.ts"), true)
    expect(first).toBe("u:http://h/live/u/p/9.ts")
    expect(shifted).toBe(first)
  })

  it("falls back to tvg-id for an M3U channel with no URL", () => {
    expect(channelOverrideKey({ id: 3, name: "Sky", tvgId: "sky.de" }, true)).toBe("t:sky.de")
  })

  it("falls back to the normalized name when there is no URL or tvg-id", () => {
    expect(channelOverrideKey({ id: 3, name: "  Sky  Sport  " }, true)).toBe(`n:${normalize("  Sky  Sport  ")}`)
    expect(normalize("  Sky  Sport  ")).toBe("sky sport")
  })

  it("returns an empty key when there is nothing to key on", () => {
    expect(channelOverrideKey({ id: 0, name: "" }, true)).toBe("")
    expect(channelOverrideKey({ id: "", name: "x" }, false)).toBe("")
  })
})

describe("overrideIdentity", () => {
  it("captures the trimmed provider name and tvg-id", () => {
    expect(overrideIdentity({ id: 1, name: "  Sky  ", tvgId: " sky.de " })).toEqual({
      srcName: "Sky",
      srcTvgId: "sky.de",
    })
  })

  it("reports nulls when the fields are absent", () => {
    expect(overrideIdentity({ id: 1 })).toEqual({ srcName: null, srcTvgId: null })
  })
})

describe("hasVisibleOverride", () => {
  it("ignores a record carrying only identity aids", () => {
    expect(hasVisibleOverride({ srcName: "Sky", srcTvgId: "sky.de" })).toBe(false)
  })

  it("accepts each display field on its own", () => {
    expect(hasVisibleOverride({ name: "A" })).toBe(true)
    expect(hasVisibleOverride({ logo: "http://x/l.png" })).toBe(true)
    expect(hasVisibleOverride({ chno: 5 })).toBe(true)
    expect(hasVisibleOverride({ hidden: true })).toBe(true)
    expect(hasVisibleOverride(null)).toBe(false)
  })
})

describe("applyChannelOverrides", () => {
  it("returns the very same array when there is nothing to apply", () => {
    const channels = [xtreamChannel(1)]
    expect(applyChannelOverrides(channels, {}, { isM3U: false })).toBe(channels)
    expect(applyChannelOverrides(channels, null, { isM3U: false })).toBe(channels)
  })

  it("replaces the name and recomputes norm so search still matches", () => {
    const overrides: ChannelOverrideMap = { "x:1": { name: "My Sports" } }
    const [channel] = applyChannelOverrides([xtreamChannel(1)], overrides, { isM3U: false })
    expect(channel.name).toBe("My Sports")
    expect(channel.norm).toContain("my sports")
    expect(channel.overrideKey).toBe("x:1")
  })

  it("replaces the logo and the channel number", () => {
    const overrides: ChannelOverrideMap = { "x:1": { logo: "http://x/l.png", chno: 42 } }
    const [channel] = applyChannelOverrides([xtreamChannel(1)], overrides, { isM3U: false })
    expect(channel.logo).toBe("http://x/l.png")
    expect(channel.chno).toBe(42)
  })

  it("does not mutate the provider channel it overlays", () => {
    const source = xtreamChannel(1)
    applyChannelOverrides([source], { "x:1": { name: "Renamed" } }, { isM3U: false })
    expect(source.name).toBe("Channel 1")
  })

  it("drops hidden channels by default and keeps them with includeHidden", () => {
    const overrides: ChannelOverrideMap = { "x:2": { hidden: true } }
    const channels = [xtreamChannel(1), xtreamChannel(2), xtreamChannel(3)]
    expect(applyChannelOverrides(channels, overrides, { isM3U: false })).toHaveLength(2)
    const all = applyChannelOverrides(channels, overrides, { isM3U: false, includeHidden: true })
    expect(all).toHaveLength(3)
    expect(all[1].hidden).toBe(true)
  })

  it("follows an M3U channel across a positional id shift", () => {
    const overrides: ChannelOverrideMap = { "u:http://h/b.ts": { name: "Kept" } }
    const before = applyChannelOverrides(
      [m3uChannel(1, "http://h/a.ts"), m3uChannel(2, "http://h/b.ts")],
      overrides,
      { isM3U: true }
    )
    expect(before[1].name).toBe("Kept")
    // Provider inserts a channel at the top: every id shifts by one.
    const after = applyChannelOverrides(
      [m3uChannel(1, "http://h/new.ts"), m3uChannel(2, "http://h/a.ts"), m3uChannel(3, "http://h/b.ts")],
      overrides,
      { isM3U: true }
    )
    expect(after[2].name).toBe("Kept")
    expect(after[0].name).toBe("Channel 1")
    expect(after[1].name).toBe("Channel 2")
  })

  it("re-matches through tvg-id when the stream URL changed", () => {
    const overrides: ChannelOverrideMap = {
      "u:http://h/old-token/9.ts": { name: "Kept", srcTvgId: "sky.de" },
    }
    const [channel] = applyChannelOverrides(
      [m3uChannel(1, "http://h/new-token/9.ts", { tvgId: "sky.de" })],
      overrides,
      { isM3U: true }
    )
    expect(channel.name).toBe("Kept")
  })

  it("refuses the tvg-id fallback when two channels share that tvg-id", () => {
    const overrides: ChannelOverrideMap = {
      "u:http://h/gone.ts": { name: "Kept", srcTvgId: "sky.de" },
    }
    const result = applyChannelOverrides(
      [
        m3uChannel(1, "http://h/sd.ts", { tvgId: "sky.de" }),
        m3uChannel(2, "http://h/hd.ts", { tvgId: "sky.de" }),
      ],
      overrides,
      { isM3U: true }
    )
    expect(result.map((channel) => channel.name)).toEqual(["Channel 1", "Channel 2"])
  })

  it("refuses the tvg-id fallback when two records claim that tvg-id", () => {
    const overrides: ChannelOverrideMap = {
      "u:http://h/gone-a.ts": { name: "A", srcTvgId: "sky.de" },
      "u:http://h/gone-b.ts": { name: "B", srcTvgId: "sky.de" },
    }
    const [channel] = applyChannelOverrides(
      [m3uChannel(1, "http://h/live.ts", { tvgId: "sky.de" })],
      overrides,
      { isM3U: true }
    )
    expect(channel.name).toBe("Channel 1")
  })

  it("prefers the exact key over a tvg-id fallback that points elsewhere", () => {
    const overrides: ChannelOverrideMap = {
      "u:http://h/a.ts": { name: "Exact", srcTvgId: "sky.de" },
      "u:http://h/gone.ts": { name: "Fallback", srcTvgId: "sky.de" },
    }
    const [channel] = applyChannelOverrides(
      [m3uChannel(1, "http://h/a.ts", { tvgId: "sky.de" })],
      overrides,
      { isM3U: true }
    )
    expect(channel.name).toBe("Exact")
  })

  it("ignores a record that carries only identity aids", () => {
    const overrides: ChannelOverrideMap = { "x:1": { srcName: "Channel 1", srcTvgId: "a" } }
    const [channel] = applyChannelOverrides([xtreamChannel(1)], overrides, { isM3U: false })
    expect(channel.overrideKey).toBeUndefined()
  })

  it("keeps an Xtream override off a same-numbered M3U channel", () => {
    const overrides: ChannelOverrideMap = { "x:1": { name: "Xtream only" } }
    const [channel] = applyChannelOverrides([m3uChannel(1, "http://h/a.ts")], overrides, {
      isM3U: true,
    })
    expect(channel.name).toBe("Channel 1")
  })
})

describe("stripAffix", () => {
  it("strips a prefix and trims the gap it leaves", () => {
    expect(stripAffix("US| ESPN HD", "US|", "")).toBe("ESPN HD")
  })

  it("strips a suffix", () => {
    expect(stripAffix("ESPN HD", "", "HD")).toBe("ESPN")
  })

  it("strips both ends in one pass", () => {
    expect(stripAffix("US| ESPN HD", "US|", "HD")).toBe("ESPN")
  })

  it("matches case-insensitively", () => {
    expect(stripAffix("us| ESPN", "US|", "")).toBe("ESPN")
  })

  it("leaves a name without the affix alone", () => {
    expect(stripAffix("ESPN", "US|", "FHD")).toBe("ESPN")
  })

  it("only strips at the ends, never mid-name", () => {
    expect(stripAffix("ESPN HD Extra", "", "HD")).toBe("ESPN HD Extra")
  })
})

describe("planAffixStrip", () => {
  const channels = [
    m3uChannel(1, "http://h/a.ts", { name: "US| ESPN HD" }),
    m3uChannel(2, "http://h/b.ts", { name: "ESPN 2" }),
    m3uChannel(3, "http://h/c.ts", { name: "US| FOX" }),
  ]

  it("plans only the channels that actually change", () => {
    const plan = planAffixStrip(channels, "US|", "", true)
    expect(plan.map((entry) => entry.to)).toEqual(["ESPN HD", "FOX"])
    expect(plan[0].from).toBe("US| ESPN HD")
    expect(plan[0].key).toBe("u:http://h/a.ts")
  })

  it("records the identity aids for each planned rename", () => {
    const plan = planAffixStrip(
      [m3uChannel(1, "http://h/a.ts", { name: "US| ESPN", tvgId: "espn.us" })],
      "US|",
      "",
      true
    )
    expect(plan[0].srcName).toBe("US| ESPN")
    expect(plan[0].srcTvgId).toBe("espn.us")
  })

  it("returns nothing when both affixes are blank", () => {
    expect(planAffixStrip(channels, "", "  ", true)).toEqual([])
  })

  it("skips a rename that would empty the name", () => {
    expect(planAffixStrip([m3uChannel(1, "http://h/a.ts", { name: "HD" })], "", "HD", true)).toEqual([])
  })

  it("plans a name-only channel through its normalized-name key", () => {
    const plan = planAffixStrip([{ id: 0, name: "US| X" }], "US|", "", true)
    expect(plan).toHaveLength(1)
    expect(plan[0].key).toBe("n:us x")
  })

  it("skips a channel with no name to key on", () => {
    expect(planAffixStrip([{ id: 0, name: "" }], "US|", "", true)).toEqual([])
  })
})

describe("resolveOverrideKey", () => {
  it("derives a key for a channel that has no override yet", () => {
    expect(resolveOverrideKey(m3uChannel(1, "http://h/a.ts"), true)).toBe("u:http://h/a.ts")
  })

  it("reuses the key an already-overridden channel was matched by", () => {
    const overridden = { ...m3uChannel(1, "http://h/a.ts"), overrideKey: "u:http://h/old.ts" }
    expect(resolveOverrideKey(overridden, true)).toBe("u:http://h/old.ts")
  })

  it("keeps a renamed name-keyed channel on its original record", () => {
    // No URL and no tvg-id, so the key hashes the name - and the name is what changed.
    const provider = { id: 1, name: "Sky Sport" }
    const overrides: ChannelOverrideMap = { "n:sky sport": { name: "My Sports", srcName: "Sky Sport" } }
    const [overridden] = applyChannelOverrides([provider], overrides, { isM3U: true })
    expect(overridden.name).toBe("My Sports")
    // Re-deriving would give "n:my sports" and orphan the record.
    expect(channelOverrideKey(overridden, true)).toBe("n:my sports")
    expect(resolveOverrideKey(overridden, true)).toBe("n:sky sport")
  })
})

describe("planAffixStrip over already-renamed channels", () => {
  it("targets the original record instead of minting a second one", () => {
    const provider = { id: 1, name: "Sky Sport HD" }
    const overrides: ChannelOverrideMap = { "n:sky sport hd": { name: "US| Sky Sport HD", srcName: "Sky Sport HD" } }
    const [overridden] = applyChannelOverrides([provider], overrides, { isM3U: true })
    const plan = planAffixStrip([overridden], "US|", "", true)
    expect(plan).toHaveLength(1)
    expect(plan[0].key).toBe("n:sky sport hd")
    expect(plan[0].to).toBe("Sky Sport HD")
  })
})

describe("sanitizeOverrideName", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(sanitizeOverrideName("  Sky   Sport  1  ")).toBe("Sky Sport 1")
  })

  it("caps a pasted wall of text", () => {
    const long = "x".repeat(5000)
    expect(sanitizeOverrideName(long)).toHaveLength(MAX_OVERRIDE_NAME_LENGTH)
  })

  it("flattens newlines and tabs that would break a single-line row", () => {
    expect(sanitizeOverrideName("Sky\n\tSport")).toBe("Sky Sport")
  })

  it("keeps emoji, CJK and RTL text intact", () => {
    expect(sanitizeOverrideName("📺 Sky")).toBe("📺 Sky")
    expect(sanitizeOverrideName("中央电视台")).toBe("中央电视台")
    expect(sanitizeOverrideName("قناة")).toBe("قناة")
  })

  it("treats whitespace-only and non-strings as no override", () => {
    expect(sanitizeOverrideName("   ")).toBe("")
    expect(sanitizeOverrideName(null)).toBe("")
    expect(sanitizeOverrideName(42)).toBe("")
  })
})

describe("sanitizeOverrideLogo", () => {
  it("accepts http and https URLs", () => {
    expect(sanitizeOverrideLogo("https://x.test/l.png")).toBe("https://x.test/l.png")
    expect(sanitizeOverrideLogo(" http://x.test/l.png ")).toBe("http://x.test/l.png")
  })

  it("accepts an inline image data URI", () => {
    const uri = "data:image/png;base64,iVBORw0KGgo="
    expect(sanitizeOverrideLogo(uri)).toBe(uri)
  })

  it("rejects a scheme that could never render an image", () => {
    expect(sanitizeOverrideLogo("javascript:alert(1)")).toBe("")
    expect(sanitizeOverrideLogo("blob:https://x.test/abc")).toBe("")
    expect(sanitizeOverrideLogo("file:///etc/passwd")).toBe("")
    expect(sanitizeOverrideLogo("data:text/html,<script>")).toBe("")
  })

  it("rejects a relative path, since the override is not page-scoped", () => {
    expect(sanitizeOverrideLogo("/logos/sky.png")).toBe("")
  })

  it("rejects junk and over-long values", () => {
    expect(sanitizeOverrideLogo("not a url")).toBe("")
    expect(sanitizeOverrideLogo("https://x.test/" + "a".repeat(MAX_OVERRIDE_LOGO_LENGTH))).toBe("")
    expect(sanitizeOverrideLogo("")).toBe("")
    expect(sanitizeOverrideLogo(undefined)).toBe("")
  })
})

describe("sanitizeOverrideChno", () => {
  it("floors a decimal and keeps a plain number", () => {
    expect(sanitizeOverrideChno(12)).toBe(12)
    expect(sanitizeOverrideChno("12.9")).toBe(12)
  })

  it("rejects zero, negatives and anything past the cap", () => {
    expect(sanitizeOverrideChno(0)).toBeNull()
    expect(sanitizeOverrideChno(-5)).toBeNull()
    expect(sanitizeOverrideChno(MAX_OVERRIDE_CHNO + 1)).toBeNull()
    expect(sanitizeOverrideChno(MAX_OVERRIDE_CHNO)).toBe(MAX_OVERRIDE_CHNO)
  })

  it("rejects the values a number input can still produce", () => {
    expect(sanitizeOverrideChno("1e999")).toBeNull()
    expect(sanitizeOverrideChno(Infinity)).toBeNull()
    expect(sanitizeOverrideChno(NaN)).toBeNull()
    expect(sanitizeOverrideChno("")).toBeNull()
    expect(sanitizeOverrideChno("abc")).toBeNull()
  })
})
