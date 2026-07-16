// Facade for the "Add from website" stream sniffer. On Android the page is
// loaded in a throwaway WebView by MainActivity's AndroidSniffer bridge; on
// desktop it's loaded in a hidden Tauri webview window by `sniffer.rs`. Both
// report every request that looks like a manifest as an `xt:sniff-candidate`
// event (DOM CustomEvent on Android, Tauri event on desktop) with the same
// shape. classifySniffedUrl / rankSniffCandidates (sniff-classify.ts) do the
// real classification - this only wires each bridge to that classifier.

import { classifySniffedUrl, rankSniffCandidates } from "@/scripts/lib/sniff-classify.ts"
import type { SniffCandidate } from "@/scripts/lib/sniff-classify.ts"
import { addEntry } from "@/scripts/lib/creds.js"
import { log, redactUrl } from "@/scripts/lib/log.js"

const isAndroid =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const desktopSnifferAvailable = isTauri && !isAndroid

export const snifferAvailable: boolean =
  typeof window !== "undefined" &&
  ((isAndroid && !!window.AndroidSniffer?.startSniff) || desktopSnifferAvailable)

export interface SniffProgress {
  stage: "loading" | "waiting"
}

export interface SniffResult {
  candidates: SniffCandidate[]
  drmSeen: boolean
  favicon: string | null
}

const DEFAULT_TIMEOUT_MS = 25000

interface RawCandidateDetail {
  url?: string
  userAgent?: string | null
  referer?: string | null
}

interface RawDoneDetail {
  favicon?: string | null
}

/** Accumulates raw candidate reports from either bridge into ranked SniffCandidates. */
class SniffAccumulator {
  private readonly collected: SniffCandidate[] = []
  private drmSeen = false
  private favicon: string | null = null

  addCandidate(detail: RawCandidateDetail | undefined): void {
    const url = detail?.url
    if (!url) return
    const classification = classifySniffedUrl(url)
    if (!classification) return
    this.collected.push({
      url,
      kind: classification.kind,
      isMaster: classification.isMaster,
      userAgent: detail?.userAgent ?? null,
      referer: detail?.referer ?? null,
    })
  }

  markDrmSeen(): void {
    this.drmSeen = true
  }

  setFavicon(detail: RawDoneDetail | undefined): void {
    this.favicon = detail?.favicon ?? null
  }

  resolveResult(): SniffResult {
    return {
      candidates: rankSniffCandidates(this.collected),
      drmSeen: this.drmSeen,
      favicon: this.favicon,
    }
  }
}

/**
 * Load `pageUrl` in the platform sniffer and resolve with every playable
 * manifest it saw, ranked best-first. Resolves with an empty candidate list
 * (never rejects) on timeout or when the sniffer is unavailable; check
 * `drmSeen` to tell "nothing found" apart from "found, but DRM-guarded".
 */
export async function sniffPage(
  pageUrl: string,
  opts: { timeoutMs?: number; onProgress?: (progress: SniffProgress) => void } = {},
): Promise<SniffResult> {
  if (!snifferAvailable) return { candidates: [], drmSeen: false, favicon: null }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return desktopSnifferAvailable
    ? sniffPageDesktop(pageUrl, timeoutMs, opts)
    : sniffPageAndroid(pageUrl, timeoutMs, opts)
}

function sniffPageAndroid(
  pageUrl: string,
  timeoutMs: number,
  opts: { onProgress?: (progress: SniffProgress) => void },
): Promise<SniffResult> {
  return new Promise<SniffResult>((resolve) => {
    const accumulator = new SniffAccumulator()
    let settled = false
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    const onCandidate = (event: Event) => {
      accumulator.addCandidate((event as CustomEvent).detail as RawCandidateDetail | undefined)
      opts.onProgress?.({ stage: "waiting" })
    }
    const onDone = (event: Event) => {
      accumulator.setFavicon((event as CustomEvent).detail as RawDoneDetail | undefined)
      settle()
    }
    const onDrm = () => accumulator.markDrmSeen()

    function cleanup() {
      document.removeEventListener("xt:sniff-candidate", onCandidate)
      document.removeEventListener("xt:sniff-done", onDone)
      document.removeEventListener("xt:sniff-drm", onDrm)
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }

    function settle() {
      if (settled) return
      settled = true
      cleanup()
      resolve(accumulator.resolveResult())
    }

    document.addEventListener("xt:sniff-candidate", onCandidate)
    document.addEventListener("xt:sniff-done", onDone)
    document.addEventListener("xt:sniff-drm", onDrm)

    timeoutHandle = setTimeout(() => {
      log.warn("[xt:sniffer] timed out sniffing", redactUrl(pageUrl))
      cancelSniff()
      settle()
    }, timeoutMs)

    opts.onProgress?.({ stage: "loading" })
    try {
      window.AndroidSniffer?.startSniff?.(pageUrl, timeoutMs)
    } catch (err) {
      log.warn("[xt:sniffer] startSniff threw:", err)
      settle()
    }
  })
}

async function sniffPageDesktop(
  pageUrl: string,
  timeoutMs: number,
  opts: { onProgress?: (progress: SniffProgress) => void },
): Promise<SniffResult> {
  const accumulator = new SniffAccumulator()
  let settled = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let unlistenFns: Array<() => void> = []

  return new Promise<SniffResult>((resolve) => {
    function cleanup() {
      for (const unlisten of unlistenFns) unlisten()
      unlistenFns = []
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }

    function settle() {
      if (settled) return
      settled = true
      cleanup()
      resolve(accumulator.resolveResult())
    }

    ;(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        const { listen } = await import("@tauri-apps/api/event")

        unlistenFns.push(
          await listen<RawCandidateDetail>("xt:sniff-candidate", (event) => {
            accumulator.addCandidate(event.payload)
            opts.onProgress?.({ stage: "waiting" })
          }),
        )
        unlistenFns.push(
          await listen<RawDoneDetail>("xt:sniff-done", (event) => {
            accumulator.setFavicon(event.payload)
            settle()
          }),
        )
        unlistenFns.push(await listen("xt:sniff-drm", () => accumulator.markDrmSeen()))

        timeoutHandle = setTimeout(() => {
          log.warn("[xt:sniffer] timed out sniffing", redactUrl(pageUrl))
          cancelSniff()
          settle()
        }, timeoutMs)

        opts.onProgress?.({ stage: "loading" })
        await invoke("sniff_page", { url: pageUrl, timeoutMs })
      } catch (err) {
        log.warn("[xt:sniffer] sniff_page invoke threw:", err)
        settle()
      }
    })()
  })
}

/** Cancel an in-flight sniff. Safe to call when nothing is running. */
export function cancelSniff(): void {
  if (desktopSnifferAvailable) {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        await invoke("cancel_sniff")
      } catch (err) {
        log.warn("[xt:sniffer] cancel_sniff invoke threw:", err)
      }
    })()
    return
  }
  try {
    window.AndroidSniffer?.cancelSniff?.()
  } catch (err) {
    log.warn("[xt:sniffer] cancelSniff threw:", err)
  }
}

export interface SaveSniffedStreamOptions {
  title: string
  sourcePageUrl?: string
  logo?: string | null
  favicon?: string | null
}

export interface SniffedPlaylistEntry {
  _id: string
  type: "m3u"
  url: string
  title: string
  logo?: string
  streamHeaders?: { userAgent?: string; referer?: string }
  sourcePageUrl?: string
  [key: string]: unknown
}

/**
 * Save a picked candidate as a new m3u playlist entry. `streamHeaders`,
 * `sourcePageUrl`, and `logo` are new optional fields on m3u entries -
 * addEntry spreads unknown keys onto the stored entry verbatim, so no
 * creds.js change is needed for them to persist.
 */
export async function saveSniffedStream(
  candidate: SniffCandidate,
  opts: SaveSniffedStreamOptions,
): Promise<SniffedPlaylistEntry> {
  const streamHeaders: { userAgent?: string; referer?: string } = {}
  if (candidate.userAgent) streamHeaders.userAgent = candidate.userAgent
  if (candidate.referer) streamHeaders.referer = candidate.referer
  const logo = opts.logo ?? opts.favicon ?? null

  return addEntry({
    type: "m3u",
    url: candidate.url,
    title: opts.title,
    ...(logo ? { logo } : {}),
    ...(Object.keys(streamHeaders).length ? { streamHeaders } : {}),
    ...(opts.sourcePageUrl ? { sourcePageUrl: opts.sourcePageUrl } : {}),
  })
}
