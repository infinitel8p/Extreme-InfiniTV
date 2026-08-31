/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Node 24+ ships an experimental native `localStorage` (undefined without
// --localstorage-file) that shadows jsdom's; stub it with a real in-memory Storage.
const localStorageStore = new Map<string, string>()
const localStorageMock: Storage = {
  getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key)! : null),
  setItem: (key, value) => {
    localStorageStore.set(key, String(value))
  },
  removeItem: (key) => {
    localStorageStore.delete(key)
  },
  clear: () => {
    localStorageStore.clear()
  },
  key: (index) => Array.from(localStorageStore.keys())[index] ?? null,
  get length() {
    return localStorageStore.size
  },
}

beforeEach(() => {
  vi.stubGlobal("localStorage", localStorageMock)
  localStorageStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

import { addEntry, getEntries, restoreState, xtreamCandidatesFor } from "@/scripts/lib/creds.js"

const PRIMARY = { type: "xtream", serverUrl: "http://primary.example", username: "user", password: "pass" }

describe("xtream mirror credential validation", () => {
  beforeEach(async () => {
    await restoreState({ entries: [], selectedId: "" })
  })

  it("keeps a well-formed mirror", async () => {
    const entry = await addEntry({
      ...PRIMARY,
      mirrors: [{ serverUrl: "http://backup.example/", username: "mirroruser", password: "mirrorpass" }],
    })
    expect(entry.mirrors).toEqual([
      { serverUrl: "http://backup.example", username: "mirroruser", password: "mirrorpass" },
    ])
  })

  it("trims surrounding whitespace off a mirror password", async () => {
    const entry = await addEntry({
      ...PRIMARY,
      mirrors: [{ serverUrl: "http://backup.example", username: " mirroruser ", password: "  mirrorpass\n" }],
    })
    expect(entry.mirrors).toEqual([
      { serverUrl: "http://backup.example", username: "mirroruser", password: "mirrorpass" },
    ])
  })

  it("drops a mirror whose password carries a pasted-in tail", async () => {
    const entry = await addEntry({
      ...PRIMARY,
      mirrors: [{ serverUrl: "http://backup.example", username: "mirroruser", password: "23d0f5aad1 http" }],
    })
    expect(entry.mirrors).toEqual([])
  })

  it("drops a mirror whose username carries interior whitespace", async () => {
    const entry = await addEntry({
      ...PRIMARY,
      mirrors: [{ serverUrl: "http://backup.example", username: "mirror user", password: "mirrorpass" }],
    })
    expect(entry.mirrors).toEqual([])
  })

  it("omits an already-stored broken mirror from the candidate list", async () => {
    await restoreState({
      entries: [
        {
          _id: "stored",
          type: "xtream",
          serverUrl: "http://primary.example",
          username: "user",
          password: "pass",
          mirrors: [
            { serverUrl: "http://broken.example", username: "mirroruser", password: "23d0f5aad1 http" },
            { serverUrl: "http://good.example", username: "mirroruser", password: "mirrorpass" },
          ],
        },
      ],
      selectedId: "stored",
    })
    const [entry] = await getEntries()
    expect(entry.mirrors).toHaveLength(2)

    const candidates = xtreamCandidatesFor(entry)
    expect(candidates.map((candidate) => candidate.host)).toEqual([
      "http://primary.example",
      "http://good.example",
    ])
  })
})
