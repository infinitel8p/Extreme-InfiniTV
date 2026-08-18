import { describe, it, expect, beforeEach, vi } from "vitest"

const localContentStore = new Map<string, string>()
vi.mock("@/scripts/lib/local-content.js", () => ({
  getLocalContent: vi.fn(async (entryId: string) =>
    localContentStore.has(entryId) ? localContentStore.get(entryId)! : ""
  ),
  setLocalContent: vi.fn(async (entryId: string, text: string) => {
    localContentStore.set(entryId, text)
    return true
  }),
}))

import { getLocalContent } from "@/scripts/lib/local-content.js"
import {
  emptyCustomDoc,
  loadCustomDoc,
  saveCustomDoc,
  addChannel,
  removeChannels,
  moveChannel,
  setOverrides,
  setCatchup,
  setChannelGroup,
  renameGroup,
  reorderGroups,
  resolveCustomChannels,
  collectSourceEntryIds,
  collectDependentCustomEntryIds,
  type CustomSource,
  type SourcePool,
} from "@/scripts/lib/custom-playlist.ts"

beforeEach(() => {
  localContentStore.clear()
})

const xtreamSource = (entryId: string, streamId: number): CustomSource => ({
  kind: "xtream",
  entryId,
  streamId,
})

const m3uSource = (entryId: string, url: string, name: string): CustomSource => ({
  kind: "m3u",
  entryId,
  url,
  name,
})

const directSource = (url: string, overrides: Partial<Extract<CustomSource, { kind: "direct" }>> = {}): CustomSource => ({
  kind: "direct",
  url,
  userAgent: null,
  referer: null,
  manifestType: null,
  drmScheme: null,
  licenseKey: null,
  ...overrides,
})

describe("emptyCustomDoc", () => {
  it("returns a v1 doc with no groups or channels", () => {
    expect(emptyCustomDoc()).toEqual({ version: 1, nextId: 1, groups: [], channels: [] })
  })
})

describe("addChannel", () => {
  it("assigns sequential ids and uuid keys, and registers the group", () => {
    let doc = emptyCustomDoc()
    const first = addChannel(doc, xtreamSource("p1", 10), { name: "News", group: "Sport" })
    doc = first.doc
    const second = addChannel(doc, xtreamSource("p1", 11), { name: "Cinema" })

    expect(first.channel.id).toBe(1)
    expect(second.channel.id).toBe(2)
    expect(first.channel.key).not.toBe(second.channel.key)
    expect(typeof first.channel.key).toBe("string")
    expect(first.channel.key.length).toBeGreaterThan(0)
    expect(second.doc.groups).toEqual(["Sport", "Uncategorized"])
    expect(second.doc.nextId).toBe(3)
  })

  it("does not mutate the input doc", () => {
    const doc = emptyCustomDoc()
    const snapshot = JSON.parse(JSON.stringify(doc))
    addChannel(doc, xtreamSource("p1", 1), { name: "News" })
    expect(doc).toEqual(snapshot)
  })

  it("defaults group to Uncategorized and null overrides", () => {
    const { channel } = addChannel(emptyCustomDoc(), directSource("http://x/stream.m3u8"))
    expect(channel.group).toBe("Uncategorized")
    expect(channel.overrides).toEqual({ name: null, logo: null, chno: null, tvgId: null })
    expect(channel.catchup).toBeNull()
  })
})

describe("removeChannels", () => {
  it("drops channels and prunes groups that became empty", () => {
    let doc = emptyCustomDoc()
    const first = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" })
    doc = first.doc
    const second = addChannel(doc, xtreamSource("p1", 2), { name: "B", group: "Sport" })
    doc = second.doc

    const result = removeChannels(doc, [first.channel.key])
    expect(result.channels).toHaveLength(1)
    expect(result.channels[0].key).toBe(second.channel.key)
    expect(result.groups).toEqual(["Sport"])
  })

  it("keeps a group still referenced by a remaining channel", () => {
    let doc = emptyCustomDoc()
    const first = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" })
    doc = first.doc
    const second = addChannel(doc, xtreamSource("p1", 2), { name: "B", group: "News" })
    doc = second.doc

    const result = removeChannels(doc, [first.channel.key])
    expect(result.groups).toEqual(["News"])
    expect(result.channels).toHaveLength(1)
  })

  it("does not mutate the input doc", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" }).doc
    const snapshot = JSON.parse(JSON.stringify(doc))
    removeChannels(doc, ["nonexistent"])
    expect(doc).toEqual(snapshot)
  })
})

describe("moveChannel", () => {
  function buildThreeChannelDoc() {
    let doc = emptyCustomDoc()
    const first = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" })
    doc = first.doc
    const second = addChannel(doc, xtreamSource("p1", 2), { name: "B", group: "News" })
    doc = second.doc
    const third = addChannel(doc, xtreamSource("p1", 3), { name: "C", group: "Sport" })
    doc = third.doc
    return { doc, first: first.channel, second: second.channel, third: third.channel }
  }

  it("repositions a channel before another key within the same group", () => {
    const { doc, first, second } = buildThreeChannelDoc()
    const result = moveChannel(doc, second.key, first.key, "News")
    expect(result.channels.map((channel) => channel.key)).toEqual([
      second.key,
      first.key,
      doc.channels[2].key,
    ])
  })

  it("reassigns group and appends to the end of the target group's block when beforeKey is null", () => {
    const { doc, first, second, third } = buildThreeChannelDoc()
    const result = moveChannel(doc, first.key, null, "Sport")
    const keys = result.channels.map((channel) => channel.key)
    expect(keys.indexOf(third.key)).toBeLessThan(keys.indexOf(first.key))
    const moved = result.channels.find((channel) => channel.key === first.key)
    expect(moved?.group).toBe("Sport")
    expect(result.channels.find((channel) => channel.key === second.key)?.group).toBe("News")
  })

  it("registers a brand-new group name when moved there", () => {
    const { doc, first } = buildThreeChannelDoc()
    const result = moveChannel(doc, first.key, null, "Movies")
    expect(result.groups).toContain("Movies")
  })

  it("is a no-op when the key does not exist", () => {
    const { doc } = buildThreeChannelDoc()
    const result = moveChannel(doc, "missing-key", null, "News")
    expect(result).toBe(doc)
  })

  it("does not mutate the input doc", () => {
    const { doc, first } = buildThreeChannelDoc()
    const snapshot = JSON.parse(JSON.stringify(doc))
    moveChannel(doc, first.key, null, "Sport")
    expect(doc).toEqual(snapshot)
  })
})

describe("setOverrides", () => {
  it("patches only the target channel's overrides", () => {
    let doc = emptyCustomDoc()
    const first = addChannel(doc, xtreamSource("p1", 1), { name: "A" })
    doc = first.doc
    const second = addChannel(doc, xtreamSource("p1", 2), { name: "B" })
    doc = second.doc

    const result = setOverrides(doc, first.channel.key, { logo: "http://logo" })
    const patched = result.channels.find((channel) => channel.key === first.channel.key)
    const untouched = result.channels.find((channel) => channel.key === second.channel.key)
    expect(patched?.overrides.logo).toBe("http://logo")
    expect(patched?.overrides.name).toBe("A")
    expect(untouched?.overrides.logo).toBeNull()
  })
})

describe("setCatchup", () => {
  it("patches only the target channel's catchup override", () => {
    let doc = emptyCustomDoc()
    const first = addChannel(doc, xtreamSource("p1", 1), { name: "A" })
    doc = first.doc
    const second = addChannel(doc, xtreamSource("p1", 2), { name: "B" })
    doc = second.doc

    const catchup = { catchup: "append", catchupDays: 5, catchupSource: null, catchupCorrection: null }
    const result = setCatchup(doc, first.channel.key, catchup)
    expect(result.channels.find((channel) => channel.key === first.channel.key)?.catchup).toEqual(catchup)
    expect(result.channels.find((channel) => channel.key === second.channel.key)?.catchup).toBeNull()
  })

  it("clears the override back to null", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), {
      name: "A",
      catchup: { catchup: "shift", catchupDays: 3, catchupSource: null, catchupCorrection: null },
    }).doc

    const result = setCatchup(doc, doc.channels[0].key, null)
    expect(result.channels[0].catchup).toBeNull()
  })

  it("does not mutate the input doc", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A" }).doc
    const snapshot = JSON.parse(JSON.stringify(doc))
    setCatchup(doc, doc.channels[0].key, { catchup: "xc", catchupDays: 1, catchupSource: null, catchupCorrection: null })
    expect(doc).toEqual(snapshot)
  })
})

describe("setChannelGroup", () => {
  it("moves multiple channels to a group and registers it", () => {
    let doc = emptyCustomDoc()
    const first = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" })
    doc = first.doc
    const second = addChannel(doc, xtreamSource("p1", 2), { name: "B", group: "News" })
    doc = second.doc

    const result = setChannelGroup(doc, [first.channel.key, second.channel.key], "Archive")
    expect(result.channels.every((channel) => channel.group === "Archive")).toBe(true)
    expect(result.groups).toContain("Archive")
  })

  it("does not mutate the input doc", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" }).doc
    const snapshot = JSON.parse(JSON.stringify(doc))
    setChannelGroup(doc, [doc.channels[0].key], "Archive")
    expect(doc).toEqual(snapshot)
  })
})

describe("renameGroup", () => {
  it("updates the groups list and every channel referencing it", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" }).doc
    doc = addChannel(doc, xtreamSource("p1", 2), { name: "B", group: "Sport" }).doc

    const result = renameGroup(doc, "News", "World News")
    expect(result.groups).toEqual(["World News", "Sport"])
    expect(result.channels.find((channel) => channel.overrides.name === "A")?.group).toBe("World News")
    expect(result.channels.find((channel) => channel.overrides.name === "B")?.group).toBe("Sport")
  })

  it("merges into an existing group instead of creating a duplicate", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" }).doc
    doc = addChannel(doc, xtreamSource("p1", 2), { name: "B", group: "Sport" }).doc
    doc = addChannel(doc, xtreamSource("p1", 3), { name: "C", group: "Sport" }).doc

    const result = renameGroup(doc, "News", "Sport")
    expect(result.groups).toEqual(["Sport"])
    expect(result.channels.every((channel) => channel.group === "Sport")).toBe(true)
    expect(result.channels).toHaveLength(3)

    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [1, 2, 3].map((id) => ({ id, name: `x${id}` })),
          buildUrl: (id: number) => `http://x/${id}`,
        },
      ],
    ])
    const resolved = resolveCustomChannels(result, pools)
    expect(resolved).toHaveLength(3)
    expect(resolved.every((channel) => channel.category === "Sport")).toBe(true)
  })

  it("does not mutate the input doc", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" }).doc
    doc = addChannel(doc, xtreamSource("p1", 2), { name: "B", group: "Sport" }).doc
    const snapshot = JSON.parse(JSON.stringify(doc))
    renameGroup(doc, "News", "World News")
    expect(doc).toEqual(snapshot)
  })
})

describe("reorderGroups", () => {
  it("reorders when given the same set of groups", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" }).doc
    doc = addChannel(doc, xtreamSource("p1", 2), { name: "B", group: "Sport" }).doc

    const result = reorderGroups(doc, ["Sport", "News"])
    expect(result.groups).toEqual(["Sport", "News"])
  })

  it("throws when the group set doesn't match", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" }).doc

    expect(() => reorderGroups(doc, ["News", "Movies"])).toThrow()
    expect(() => reorderGroups(doc, [])).toThrow()
  })

  it("throws when orderedGroups contains a duplicate that masks a missing group", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" }).doc
    doc = addChannel(doc, xtreamSource("p1", 2), { name: "B", group: "Sport" }).doc

    expect(() => reorderGroups(doc, ["News", "News"])).toThrow()
  })

  it("does not mutate the input doc", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" }).doc
    doc = addChannel(doc, xtreamSource("p1", 2), { name: "B", group: "Sport" }).doc
    const snapshot = JSON.parse(JSON.stringify(doc))
    reorderGroups(doc, ["Sport", "News"])
    expect(doc).toEqual(snapshot)
  })
})

describe("loadCustomDoc", () => {
  it("returns an empty doc when nothing is stored", async () => {
    const doc = await loadCustomDoc("entry-1")
    expect(doc).toEqual(emptyCustomDoc())
  })

  it("returns an empty doc on invalid JSON", async () => {
    localContentStore.set("entry-1", "{not json")
    const doc = await loadCustomDoc("entry-1")
    expect(doc).toEqual(emptyCustomDoc())
  })

  it("returns an empty doc when the parsed shape is missing required fields", async () => {
    localContentStore.set("entry-1", JSON.stringify({ foo: "bar" }))
    const doc = await loadCustomDoc("entry-1")
    expect(doc).toEqual(emptyCustomDoc())
  })

  it("round-trips a saved doc", async () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A", group: "News" }).doc
    await saveCustomDoc("entry-1", doc)
    const loaded = await loadCustomDoc("entry-1")
    expect(loaded).toEqual(doc)
  })

  it("throws instead of returning an empty doc when the storage read fails (null, not empty)", async () => {
    vi.mocked(getLocalContent).mockResolvedValueOnce(null)
    await expect(loadCustomDoc("entry-1")).rejects.toThrow(/storage read failed/)
  })
})

describe("collectSourceEntryIds", () => {
  it("returns each referenced playlist entry id once", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A" }).doc
    doc = addChannel(doc, xtreamSource("p1", 2), { name: "B" }).doc
    doc = addChannel(doc, m3uSource("p2", "http://host/c.m3u8", "C"), { name: "C" }).doc

    expect(collectSourceEntryIds(doc).sort()).toEqual(["p1", "p2"])
  })

  it("ignores direct sources and malformed channel records", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, directSource("http://raw/stream.m3u8"), { name: "Direct" }).doc
    doc = addChannel(doc, xtreamSource("p1", 1), { name: "A" }).doc
    doc = {
      ...doc,
      channels: [
        ...doc.channels,
        { ...doc.channels[0], key: "broken", sources: undefined as unknown as CustomSource[] },
        { ...doc.channels[0], key: "empty-entry", sources: [xtreamSource("", 5)] },
      ],
    }

    expect(collectSourceEntryIds(doc)).toEqual(["p1"])
  })

  it("returns nothing for an empty doc", () => {
    expect(collectSourceEntryIds(emptyCustomDoc())).toEqual([])
  })
})

describe("collectDependentCustomEntryIds", () => {
  it("returns the custom entries referencing the source", () => {
    const dependents = collectDependentCustomEntryIds("src-1", [
      { entryId: "cust-1", sourceEntryIds: ["src-1", "src-2"] },
      { entryId: "cust-2", sourceEntryIds: ["src-2"] },
    ])
    expect(dependents).toEqual(["cust-1"])
  })

  it("follows custom-on-custom references transitively", () => {
    const dependents = collectDependentCustomEntryIds("src-1", [
      { entryId: "cust-1", sourceEntryIds: ["src-1"] },
      { entryId: "cust-2", sourceEntryIds: ["cust-1"] },
      { entryId: "cust-3", sourceEntryIds: ["src-9"] },
    ])
    expect(dependents.sort()).toEqual(["cust-1", "cust-2"])
  })

  it("terminates on a reference cycle", () => {
    const dependents = collectDependentCustomEntryIds("src-1", [
      { entryId: "cust-1", sourceEntryIds: ["src-1", "cust-2"] },
      { entryId: "cust-2", sourceEntryIds: ["cust-1"] },
    ])
    expect(dependents.sort()).toEqual(["cust-1", "cust-2"])
  })

  it("never returns the source itself when it references itself", () => {
    expect(
      collectDependentCustomEntryIds("cust-1", [{ entryId: "cust-1", sourceEntryIds: ["cust-1"] }])
    ).toEqual([])
  })

  it("tolerates missing ids, missing source lists and an empty source id", () => {
    expect(
      collectDependentCustomEntryIds("src-1", [
        { entryId: "", sourceEntryIds: ["src-1"] },
        { entryId: "cust-1", sourceEntryIds: undefined as unknown as string[] },
        { entryId: "cust-2", sourceEntryIds: ["", "src-1"] },
      ])
    ).toEqual(["cust-2"])
    expect(collectDependentCustomEntryIds("", [{ entryId: "cust-1", sourceEntryIds: [""] }])).toEqual([])
  })
})

describe("resolveCustomChannels", () => {
  it("resolves an xtream source by streamId using buildUrl", () => {
    const buildUrl = vi.fn((streamId: number) => `http://host/live/u/p/${streamId}.m3u8`)
    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [{ id: 10, name: "BBC One", logo: "http://logo/bbc", tvgId: "bbc.uk", chno: 1 }],
          buildUrl,
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 10), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].name).toBe("BBC One")
    expect(resolved[0].url).toBe("http://host/live/u/p/10.m3u8")
    expect(buildUrl).toHaveBeenCalledWith(10)
    expect(resolved[0].unresolved).toBeUndefined()
  })

  it("resolves an m3u source by exact url match", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p2",
        {
          kind: "m3u",
          channels: [{ name: "CNN", url: "http://host/cnn.m3u8", logo: null, isRadio: false }],
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, m3uSource("p2", "http://host/cnn.m3u8", "CNN"), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].url).toBe("http://host/cnn.m3u8")
    expect(resolved[0].unresolved).toBeUndefined()
  })

  it("falls back to name match when url doesn't match for m3u sources", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p2",
        {
          kind: "m3u",
          channels: [{ name: "CNN", url: "http://host/cnn-new-url.m3u8", logo: null, isRadio: false }],
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, m3uSource("p2", "http://host/cnn-old-url.m3u8", "CNN"), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].url).toBe("http://host/cnn-new-url.m3u8")
  })

  it("marks a channel unresolved when the name fallback is ambiguous in the pool", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p2",
        {
          kind: "m3u",
          channels: [
            { name: "CNN", url: "http://host/cnn-region-a.m3u8", logo: null, isRadio: false },
            { name: "CNN", url: "http://host/cnn-region-b.m3u8", logo: null, isRadio: false },
          ],
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, m3uSource("p2", "http://host/cnn-old-url.m3u8", "CNN"), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].unresolved).toBe(true)
  })

  it("lets overrides win over the resolved source fields", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [{ id: 10, name: "BBC One", logo: "http://logo/bbc", tvgId: "bbc.uk", chno: 1 }],
          buildUrl: (streamId: number) => `http://host/${streamId}.m3u8`,
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 10), {
      group: "News",
      name: "My BBC",
      logo: "http://custom-logo",
      chno: 99,
      tvgId: "custom.tvgid",
    }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].name).toBe("My BBC")
    expect(resolved[0].logo).toBe("http://custom-logo")
    expect(resolved[0].chno).toBe(99)
    expect(resolved[0].tvgId).toBe("custom.tvgid")
  })

  it("inherits catchup from the source channel when no override is set", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p2",
        {
          kind: "m3u",
          channels: [
            {
              name: "CNN",
              url: "http://host/cnn.m3u8",
              catchup: "shift",
              catchupDays: 7,
              catchupSource: null,
              catchupCorrection: null,
            },
          ],
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, m3uSource("p2", "http://host/cnn.m3u8", "CNN"), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].catchup).toBe("shift")
    expect(resolved[0].catchupDays).toBe(7)
  })

  it("prefers an explicit catchup override over the inherited one", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p2",
        {
          kind: "m3u",
          channels: [
            {
              name: "CNN",
              url: "http://host/cnn.m3u8",
              catchup: "shift",
              catchupDays: 7,
              catchupSource: null,
              catchupCorrection: null,
            },
          ],
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, m3uSource("p2", "http://host/cnn.m3u8", "CNN"), {
      group: "News",
      catchup: { catchup: "append", catchupDays: 3, catchupSource: "http://override", catchupCorrection: 1 },
    }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].catchup).toBe("append")
    expect(resolved[0].catchupDays).toBe(3)
    expect(resolved[0].catchupSource).toBe("http://override")
    expect(resolved[0].catchupCorrection).toBe(1)
  })

  it("carries per-channel headers and DRM fields for direct sources", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(
      doc,
      directSource("http://raw.example/stream.mpd", {
        userAgent: "MyPlayer/1.0",
        referer: "http://example.com",
        manifestType: "mpd",
        drmScheme: "clearkey",
        licenseKey: "kid:key",
      }),
      { group: "Custom", name: "Direct Channel" }
    ).doc

    const resolved = resolveCustomChannels(doc, new Map())
    expect(resolved[0].url).toBe("http://raw.example/stream.mpd")
    expect(resolved[0].userAgent).toBe("MyPlayer/1.0")
    expect(resolved[0].referer).toBe("http://example.com")
    expect(resolved[0].manifestType).toBe("mpd")
    expect(resolved[0].drmScheme).toBe("clearkey")
    expect(resolved[0].licenseKey).toBe("kid:key")
    expect(resolved[0].unresolved).toBeUndefined()
  })

  it("carries manifestType/drmScheme/licenseKey/userAgent/referer for an m3u-sourced channel", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p2",
        {
          kind: "m3u",
          channels: [
            {
              name: "CNN",
              url: "http://host/cnn.mpd",
              logo: null,
              isRadio: false,
              userAgent: "MyPlayer/1.0",
              referer: "http://example.com",
              manifestType: "mpd",
              drmScheme: "clearkey",
              licenseKey: "kid:key",
            },
          ],
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, m3uSource("p2", "http://host/cnn.mpd", "CNN"), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].userAgent).toBe("MyPlayer/1.0")
    expect(resolved[0].referer).toBe("http://example.com")
    expect(resolved[0].manifestType).toBe("mpd")
    expect(resolved[0].drmScheme).toBe("clearkey")
    expect(resolved[0].licenseKey).toBe("kid:key")
  })

  it("carries manifestType/drmScheme/licenseKey/userAgent/referer for an xtream-sourced channel", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [
            {
              id: 10,
              name: "BBC One",
              userAgent: "MyPlayer/1.0",
              referer: "http://example.com",
              manifestType: "mpd",
              drmScheme: "clearkey",
              licenseKey: "kid:key",
            },
          ],
          buildUrl: (streamId: number) => `http://host/${streamId}.mpd`,
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 10), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].userAgent).toBe("MyPlayer/1.0")
    expect(resolved[0].referer).toBe("http://example.com")
    expect(resolved[0].manifestType).toBe("mpd")
    expect(resolved[0].drmScheme).toBe("clearkey")
    expect(resolved[0].licenseKey).toBe("kid:key")
  })

  it("carries tvgShift through from an m3u-sourced channel", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p2",
        {
          kind: "m3u",
          channels: [
            { name: "CNN", url: "http://host/cnn.m3u8", logo: null, isRadio: false, tvgShift: -1 },
          ],
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, m3uSource("p2", "http://host/cnn.m3u8", "CNN"), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].tvgShift).toBe(-1)
  })

  it("carries tvgShift through from an xtream-sourced channel", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [{ id: 10, name: "BBC One", tvgShift: 2 }],
          buildUrl: (streamId: number) => `http://host/${streamId}.m3u8`,
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 10), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].tvgShift).toBe(2)
  })

  it("defaults tvgShift to null when the source channel doesn't carry one", () => {
    const pools = new Map<string, SourcePool>([
      ["p1", { kind: "xtream", channels: [{ id: 10, name: "BBC One" }], buildUrl: (id: number) => `http://x/${id}` }],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 10), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].tvgShift).toBeNull()
  })

  it("marks a channel unresolved when its source pool is missing", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("missing-entry", 5), { group: "News", name: "Ghost" }).doc

    const resolved = resolveCustomChannels(doc, new Map())
    expect(resolved[0].unresolved).toBe(true)
    expect(resolved[0].url).toBe("")
    expect(resolved[0].name).toBe("Ghost")
  })

  it("marks a channel unresolved when the streamId is missing from the pool", () => {
    const pools = new Map<string, SourcePool>([
      ["p1", { kind: "xtream", channels: [{ id: 999, name: "Other" }], buildUrl: (id: number) => `http://x/${id}` }],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 10), { group: "News", name: "Missing" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].unresolved).toBe(true)
    expect(resolved[0].name).toBe("Missing")
  })

  it("passes through tvArchive fields for xtream-sourced channels", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [{ id: 10, name: "BBC One", tvArchive: 1, tvArchiveDuration: 168 }],
          buildUrl: (streamId: number) => `http://host/${streamId}.m3u8`,
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 10), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].tvArchive).toBe(1)
    expect(resolved[0].tvArchiveDuration).toBe(168)
  })

  it("maps an archive-capable xtream source to catchup 'xc' with catchupDays from tvArchiveDuration", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [{ id: 10, name: "BBC One", tvArchive: 1, tvArchiveDuration: 168 }],
          buildUrl: (streamId: number) => `http://host/${streamId}.m3u8`,
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 10), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].catchup).toBe("xc")
    expect(resolved[0].catchupDays).toBe(168)
    expect(resolved[0].catchupSource).toBeNull()
    expect(resolved[0].catchupCorrection).toBeNull()
  })

  it("leaves catchup null for an xtream source without archive support", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [{ id: 10, name: "BBC One", tvArchive: 0 }],
          buildUrl: (streamId: number) => `http://host/${streamId}.m3u8`,
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 10), { group: "News" }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].catchup).toBeNull()
  })

  it("keeps a manual catchup override over the archive-derived 'xc' mapping", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [{ id: 10, name: "BBC One", tvArchive: 1, tvArchiveDuration: 168 }],
          buildUrl: (streamId: number) => `http://host/${streamId}.m3u8`,
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 10), {
      group: "News",
      catchup: { catchup: "append", catchupDays: 3, catchupSource: "http://override", catchupCorrection: 1 },
    }).doc

    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved[0].catchup).toBe("append")
    expect(resolved[0].catchupDays).toBe(3)
    expect(resolved[0].catchupSource).toBe("http://override")
    expect(resolved[0].catchupCorrection).toBe(1)
  })

  it("orders output by doc.groups order, then array order within a group", () => {
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 1), { group: "Sport", name: "S1" }).doc
    doc = addChannel(doc, xtreamSource("p1", 2), { group: "News", name: "N1" }).doc
    doc = addChannel(doc, xtreamSource("p1", 3), { group: "Sport", name: "S2" }).doc
    doc = addChannel(doc, xtreamSource("p1", 4), { group: "News", name: "N2" }).doc
    doc = reorderGroups(doc, ["News", "Sport"])

    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [1, 2, 3, 4].map((id) => ({ id, name: `x${id}` })),
          buildUrl: (id: number) => `http://x/${id}`,
        },
      ],
    ])
    const resolved = resolveCustomChannels(doc, pools)
    expect(resolved.map((channel) => channel.name)).toEqual(["N1", "N2", "S1", "S2"])
  })

  it("keeps a stable numeric id regardless of position in the output", () => {
    let doc = emptyCustomDoc()
    const first = addChannel(doc, xtreamSource("p1", 1), { group: "Sport", name: "S1" })
    doc = first.doc
    const second = addChannel(doc, xtreamSource("p1", 2), { group: "News", name: "N1" })
    doc = second.doc
    doc = reorderGroups(doc, ["News", "Sport"])

    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [
            { id: 1, name: "S1" },
            { id: 2, name: "N1" },
          ],
          buildUrl: (id: number) => `http://x/${id}`,
        },
      ],
    ])
    const resolved = resolveCustomChannels(doc, pools)
    const resolvedN1 = resolved.find((channel) => channel.name === "N1")
    const resolvedS1 = resolved.find((channel) => channel.name === "S1")
    expect(resolvedN1?.id).toBe(second.channel.id)
    expect(resolvedS1?.id).toBe(first.channel.id)
  })

  it("degrades a malformed channel record (missing sources) to unresolved without throwing, leaving siblings intact", () => {
    const pools = new Map<string, SourcePool>([
      [
        "p1",
        {
          kind: "xtream",
          channels: [{ id: 10, name: "BBC One" }],
          buildUrl: (streamId: number) => `http://host/${streamId}.m3u8`,
        },
      ],
    ])
    let doc = emptyCustomDoc()
    doc = addChannel(doc, xtreamSource("p1", 10), { group: "News", name: "Healthy" }).doc
    const malformed = { ...doc.channels[0], key: "malformed-key", id: 999, sources: [] as CustomSource[] }
    const malformedNoSources = {
      ...doc.channels[0],
      key: "malformed-key-2",
      id: 998,
      sources: undefined as unknown as CustomSource[],
    }
    doc = { ...doc, channels: [...doc.channels, malformed, malformedNoSources] }

    let resolved: ReturnType<typeof resolveCustomChannels> = []
    expect(() => {
      resolved = resolveCustomChannels(doc, pools)
    }).not.toThrow()

    expect(resolved).toHaveLength(3)
    const healthy = resolved.find((channel) => channel.name === "Healthy")
    expect(healthy?.unresolved).toBeUndefined()
    expect(healthy?.url).toBe("http://host/10.m3u8")
    const malformedResolved = resolved.find((channel) => channel.id === 999)
    const malformedNoSourcesResolved = resolved.find((channel) => channel.id === 998)
    expect(malformedResolved?.unresolved).toBe(true)
    expect(malformedNoSourcesResolved?.unresolved).toBe(true)
  })
})
