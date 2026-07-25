// "Add from website" stream sniffer facade over the Android WebView bridge and desktop `sniffer.rs`.

import { classifySniffedUrl, rankSniffCandidates } from "@/scripts/lib/sniff-classify.ts"
import type { SniffCandidate } from "@/scripts/lib/sniff-classify.ts"
import { addEntry, safeHttpUrl } from "@/scripts/lib/creds.js"
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

interface SniffSession {
  settle: () => void
}

/** The in-flight sniffPage() session, if any, so cancelSniff() can settle its promise immediately. */
let activeSniffSession: SniffSession | null = null

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

/** Never rejects: an empty candidate list plus `drmSeen` distinguishes DRM from nothing found. */
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
      if (activeSniffSession === session) activeSniffSession = null
      resolve(accumulator.resolveResult())
    }

    const session: SniffSession = { settle }
    activeSniffSession = session

    document.addEventListener("xt:sniff-candidate", onCandidate)
    document.addEventListener("xt:sniff-done", onDone)
    document.addEventListener("xt:sniff-drm", onDrm)

    timeoutHandle = setTimeout(() => {
      log.warn("[xt:sniffer] timed out sniffing", redactUrl(pageUrl))
      cancelSniff()
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
      if (activeSniffSession === session) activeSniffSession = null
      resolve(accumulator.resolveResult())
    }

    const session: SniffSession = { settle }
    activeSniffSession = session

    ;(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        const { listen } = await import("@tauri-apps/api/event")
        if (settled) return

        unlistenFns.push(
          await listen<RawCandidateDetail>("xt:sniff-candidate", (event) => {
            accumulator.addCandidate(event.payload)
            opts.onProgress?.({ stage: "waiting" })
          }),
        )
        if (settled) return cleanup()
        unlistenFns.push(
          await listen<RawDoneDetail>("xt:sniff-done", (event) => {
            accumulator.setFavicon(event.payload)
            settle()
          }),
        )
        if (settled) return cleanup()
        unlistenFns.push(await listen("xt:sniff-drm", () => accumulator.markDrmSeen()))
        if (settled) return cleanup()

        timeoutHandle = setTimeout(() => {
          log.warn("[xt:sniffer] timed out sniffing", redactUrl(pageUrl))
          cancelSniff()
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

/** Cancel an in-flight sniff. Settles the pending sniffPage() promise immediately, so a late native done event is ignored. Safe to call when nothing is running. */
export function cancelSniff(): void {
  const session = activeSniffSession
  activeSniffSession = null
  session?.settle()
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
  manifestType?: string | null
  [key: string]: unknown
}

/** The extra m3u fields persist because addEntry spreads unknown keys onto the stored entry verbatim. */
export async function saveSniffedStream(
  candidate: SniffCandidate,
  opts: SaveSniffedStreamOptions,
): Promise<SniffedPlaylistEntry> {
  const streamHeaders: { userAgent?: string; referer?: string } = {}
  if (candidate.userAgent) streamHeaders.userAgent = candidate.userAgent
  if (candidate.referer) streamHeaders.referer = candidate.referer
  const rawLogo = opts.logo ?? opts.favicon ?? null
  const logo = rawLogo ? safeHttpUrl(rawLogo) || null : null
  const manifestType = candidate.kind === "dash" ? "mpd" : null

  return addEntry({
    type: "m3u",
    url: candidate.url,
    title: opts.title,
    manifestType,
    ...(logo ? { logo } : {}),
    ...(Object.keys(streamHeaders).length ? { streamHeaders } : {}),
    ...(opts.sourcePageUrl ? { sourcePageUrl: opts.sourcePageUrl } : {}),
  })
}
