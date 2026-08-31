// Shared seeding for the TV motion overdrive specs: same fixture playlist and catalog shape as
// tests/e2e/tv-shell.spec.ts, but with motion left on (no xt_perf_mode) so crossfades/glide/lift run.
import type { Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"

const here = dirname(fileURLToPath(import.meta.url))
const playlistText = readFileSync(join(here, "../../visual/fixtures/playlist.m3u"), "utf8")

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let value = n
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[n] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "")
  return [parseInt(normalized.slice(0, 2), 16), parseInt(normalized.slice(2, 4), 16), parseInt(normalized.slice(4, 6), 16)]
}

/** Tiny solid-colour PNG encoder (uncompressed filter rows, zlib-deflated) for fixture artwork. */
function solidColorPng(hex: string, width = 16, height = 16): Buffer {
  const [red, green, blue] = hexToRgb(hex)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8
  ihdrData[9] = 2
  const ihdr = pngChunk("IHDR", ihdrData)

  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x++) {
      const pixelStart = rowStart + 1 + x * 3
      raw[pixelStart] = red
      raw[pixelStart + 1] = green
      raw[pixelStart + 2] = blue
    }
  }
  const idat = pngChunk("IDAT", deflateSync(raw))
  const iend = pngChunk("IEND", Buffer.alloc(0))
  return Buffer.concat([signature, ihdr, idat, iend])
}

const pngByColor = new Map<string, Buffer>()
function pngForColor(hex: string): Buffer {
  let png = pngByColor.get(hex)
  if (!png) {
    png = solidColorPng(hex)
    pngByColor.set(hex, png)
  }
  return png
}

const ENTRY_COLORS = ["ff4d6d", "4d7fff", "4dffa6", "ffce4d", "b34dff", "4dfff2", "ff9d4d", "4dd2ff"]

/** Fixture artwork URL for a movie/show id; each id gets a visibly distinct colour. */
export function entryImageUrl(id: number): string {
  return `https://fixtures.invalid/img/entry-${id}.png`
}

function colorForEntryId(id: number): string {
  return ENTRY_COLORS[id % ENTRY_COLORS.length]
}

async function routeFixtures(page: Page): Promise<void> {
  await page.route("https://fixtures.invalid/**", (route) => {
    const url = route.request().url()
    if (url.includes("playlist.m3u")) {
      return route.fulfill({ status: 200, contentType: "audio/x-mpegurl", body: playlistText })
    }
    if (url.includes("epg.xml")) {
      return route.fulfill({ status: 200, contentType: "application/xml", body: '<?xml version="1.0"?><tv></tv>' })
    }
    const entryImageMatch = url.match(/\/img\/entry-(\d+)\.png/)
    if (entryImageMatch) {
      return route.fulfill({ status: 200, contentType: "image/png", body: pngForColor(colorForEntryId(Number(entryImageMatch[1]))) })
    }
    if (url.includes("/logos/")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: pngForColor("8892b0") })
    }
    return route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.alloc(0) })
  })
}

export interface SeedTvMotionOptions {
  /** Seeds xt_perf_mode=1 instead, for the "motion off" branch of a test. */
  perfMode?: boolean
  /** Forces the device-capability effect tier via xt_tv_effects. */
  effects?: "full" | "lite"
}

function seedTvMotionLocalStorage(options: { perfMode: boolean; effects: string | null }): void {
  try {
    const { perfMode, effects } = options
    localStorage.setItem("xt_force_tv", "1")
    localStorage.setItem("xt_receiver_boot", "0")
    localStorage.setItem("xt_locale", "en")
    localStorage.setItem("xt_theme", "dark")
    if (perfMode) localStorage.setItem("xt_perf_mode", "1")
    if (effects) localStorage.setItem("xt_tv_effects", effects)
    localStorage.setItem(
      "xt_playlists",
      JSON.stringify({
        entries: [
          {
            _id: "fixture",
            type: "m3u",
            url: "https://fixtures.invalid/playlist.m3u",
            title: "Fixture TV",
            addedAt: 1,
            lastUsedAt: 1,
          },
        ],
        selectedId: "fixture",
      })
    )
  } catch {}
}

// Mirrors tv-shell.spec.ts's seedTvContent, but every movie/show gets a distinct artwork URL
// so hero-crossfade and card-image assertions can tell entries apart.
function seedTvMotionContent(): void {
  try {
    // Runs in the page: mirrors lib/text.ts normalize, which cannot be imported here.
    const normalize = (value: string) =>
      value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[|_\-()[\].,:/\\]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    const imageUrl = (id: number) => `https://fixtures.invalid/img/entry-${id}.png`
    const movies = Array.from({ length: 24 }, (_, index) => {
      const name = `Movie ${index + 1}`
      const year = String(2000 + (index % 20))
      const category = "1"
      return {
        id: index + 1,
        name,
        logo: imageUrl(index + 1),
        year,
        rating: "7.5",
        category,
        plot: "Movie plot.",
        added: 1700000000 - index * 1000,
        norm: normalize(`${name} ${category} ${year}`),
        tmdb: null,
        genre: "Drama",
      }
    })
    const shows = Array.from({ length: 8 }, (_, index) => {
      const name = `Show ${index + 1}`
      const year = String(2010 + index)
      const category = "1"
      return {
        id: 101 + index,
        name,
        logo: imageUrl(101 + index),
        year,
        rating: "8.1",
        category,
        plot: "Show plot.",
        added: 1700000000 - index * 2000,
        norm: normalize(`${name} ${category} ${year}`),
        tmdb: null,
        genre: "Drama",
      }
    })
    const episodes: Record<string, unknown[]> = {}
    let episodeId = 101000
    for (let season = 1; season <= 4; season++) {
      episodes[String(season)] = Array.from({ length: 8 }, (_, index) => ({
        id: String(++episodeId),
        episode_num: index + 1,
        title: `S${season} Episode ${index + 1}`,
        container_extension: "mp4",
        season,
        info: { duration: "00:42:00", duration_secs: 2520, plot: "Episode plot." },
      }))
    }
    const seriesInfo = {
      info: {
        name: "Show 1",
        cover: null,
        plot: "A long series description that keeps wrapping past four lines in the TV hero band. ".repeat(6),
        genre: "Drama, Mystery",
        releaseDate: "2015-03-01",
        rating: "8.4",
      },
      seasons: [{ season_number: 1 }, { season_number: 2 }, { season_number: 3 }, { season_number: 4 }],
      episodes,
    }

    localStorage.setItem(
      "xt_prefs",
      JSON.stringify({
        fixture: {
          favLive: [1, 2, 3],
          favVod: [1, 2, 3, 4],
          favSeries: [101],
          watchVod: { 6: { ts: 1700000000000, name: "Movie 6" } },
          watchSeries: { 103: { ts: 1700000500000, name: "Show 3" } },
          progVod: { 8: { position: 600, duration: 5400, ts: 1700000600000, name: "Movie 8" } },
        },
      })
    )
    ;(window as unknown as { __xtTvFixtures: unknown }).__xtTvFixtures = { movies, shows, seriesInfo }
  } catch {}
}

/** Routes the fixture provider + seeds localStorage/init state for the motion specs (motion stays on). */
export async function seedTvMotionState(page: Page, options: SeedTvMotionOptions = {}): Promise<void> {
  await routeFixtures(page)
  await page.context().addInitScript(seedTvMotionLocalStorage, {
    perfMode: options.perfMode === true,
    effects: options.effects ?? null,
  })
  await page.context().addInitScript(seedTvMotionContent)
}

/** Writes the seeded movies/shows/series-info into the IndexedDB catalog cache. Call after a first /tv goto. */
export async function seedTvMotionCatalog(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const fixtures = (window as unknown as { __xtTvFixtures: any }).__xtTvFixtures
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("xt_cache", 4)
      request.onupgradeneeded = () => {
        const database = request.result
        const store = database.objectStoreNames.contains("entries")
          ? request.transaction!.objectStore("entries")
          : database.createObjectStore("entries")
        if (!store.indexNames.contains("fetchedAt")) store.createIndex("fetchedAt", "fetchedAt")
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const record = (data: unknown) => ({ data, fetchedAt: Date.now(), ttl: 7 * 24 * 60 * 60 * 1000 })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("entries", "readwrite")
      const store = tx.objectStore("entries")
      store.put(record(fixtures.movies), "xt_cache:fixture:vod")
      store.put(record(fixtures.shows), "xt_cache:fixture:series")
      store.put(record(fixtures.seriesInfo), "xt_cache:fixture:series_info_101")
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  })
}

/** Presses a keyboard key `times` times (D-pad arrows, Enter, or a digit for zap tests). */
export async function pressDpad(page: Page, key: string, times = 1): Promise<void> {
  for (let index = 0; index < times; index++) {
    await page.keyboard.press(key)
  }
}

/** The focus-key of document.activeElement, or null when nothing carries one. */
export async function focusedCardKey(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("data-focus-key") || null)
}

export async function settleMotion(page: Page, ms = 500): Promise<void> {
  await page.waitForTimeout(ms)
}
