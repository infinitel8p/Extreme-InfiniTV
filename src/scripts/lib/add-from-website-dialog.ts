// "Add from website" dialog: page URL -> sniff -> pick candidates -> save as m3u or custom entry.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t } from "@/scripts/lib/i18n.js"
import { escapeHtml } from "@/scripts/lib/format.ts"
import { safeHttpUrl } from "@/scripts/lib/creds.js"
import { ICON_WORLD } from "@/scripts/lib/icons.ts"
import { toastSuccess, toastError } from "@/scripts/lib/toast.js"
import { log } from "@/scripts/lib/log.js"
import { sniffPage, cancelSniff, saveSniffedStream } from "@/scripts/lib/stream-sniffer.ts"
import {
  describeHlsQuality,
  summarizeHlsMaster,
  type HlsMasterSummary,
  type HlsMediaRendition,
  type SniffCandidate,
} from "@/scripts/lib/sniff-classify.ts"
import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { openAddToCustomDialog, openAddManyToCustomDialog } from "@/scripts/lib/add-to-custom-dialog.ts"
import { isPrivateOrLoopbackHost } from "@/scripts/lib/private-host.ts"
import type { CustomSource } from "@/scripts/lib/custom-playlist.ts"

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const DIALOG_ID = "add-from-website-dialog"
const QUALITY_PROBE_TIMEOUT_MS = 4000
const MAX_MANIFEST_PROBE_BYTES = 2 * 1024 * 1024
const MAX_EAGER_PROBES = 3
const ALLOWED_MANIFEST_CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/x-mpegurl",
  "audio/mpegurl",
  "text/plain",
  "application/octet-stream",
])

let dlg: HTMLDialogElement | null = null
let dialogSessionOpen = false

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

function middleTruncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const headLength = Math.ceil((maxLength - 1) / 2)
  const tailLength = Math.floor((maxLength - 1) / 2)
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`
}

/** Last one or two path segments, so "master.m3u8" shows its parent segment too. */
function primaryPathLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split("/").filter(Boolean)
    if (!segments.length) return parsed.hostname
    return segments.length > 1 ? segments.slice(-2).join("/") : segments[0]
  } catch {
    return url
  }
}

function secondaryLineLabel(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${middleTruncate(`${parsed.pathname}${parsed.search}`, 44)}`
  } catch {
    return url
  }
}

function timeoutSignal(parentSignal: AbortSignal, ms: number): AbortSignal {
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any([parentSignal, AbortSignal.timeout(ms)])
  }
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  parentSignal.addEventListener("abort", onParentAbort)
  const timer = setTimeout(() => controller.abort(), ms)
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timer)
    parentSignal.removeEventListener("abort", onParentAbort)
  })
  return controller.signal
}

/** True when the manifest's own Content-Type doesn't rule out an HLS playlist. */
function looksLikePlaylistContentType(contentType: string | null): boolean {
  const withoutParameters = contentType?.split(";")[0]?.trim().toLowerCase()
  return !withoutParameters || ALLOWED_MANIFEST_CONTENT_TYPES.has(withoutParameters)
}

/** Reads a body as text, or null once the bytes actually received pass maxBytes. */
async function readCappedText(response: Response, maxBytes: number): Promise<string | null> {
  const body = response.body
  if (!body || typeof body.getReader !== "function") {
    const buffered = await response.text()
    return buffered.length > maxBytes ? null : buffered
  }
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8")
  let received = 0
  let text = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      received += value.byteLength
      if (received > maxBytes) return null
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    void reader.cancel().catch(() => {})
  }
}

interface ProbeManifestResult {
  status: number
  contentType: string | null
  body: string
}

/** Routes through the Rust-side probe, which does the resolved-IP SSRF check the guard above can't. */
async function fetchManifestSummaryViaTauri(candidate: SniffCandidate, parentSignal: AbortSignal): Promise<HlsMasterSummary | null> {
  if (parentSignal.aborted) return null
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const result = await invoke<ProbeManifestResult>("probe_manifest", {
      url: candidate.url,
      userAgent: candidate.userAgent ?? null,
      referer: candidate.referer ?? null,
      timeoutMs: QUALITY_PROBE_TIMEOUT_MS,
      maxBytes: MAX_MANIFEST_PROBE_BYTES,
    })
    if (result.status < 200 || result.status >= 300) return null
    if (!looksLikePlaylistContentType(result.contentType)) return null
    return summarizeHlsMaster(result.body)
  } catch (err) {
    log.warn("[xt:sniffer] probe_manifest failed:", err)
    return null
  }
}

/** Fetches an HLS candidate's manifest and parses it, or null on failure/DASH/no data/private host. */
async function fetchManifestSummary(candidate: SniffCandidate, parentSignal: AbortSignal): Promise<HlsMasterSummary | null> {
  if (candidate.kind !== "hls") return null
  if (isPrivateOrLoopbackHost(candidate.url)) return null
  if (isTauri) return fetchManifestSummaryViaTauri(candidate, parentSignal)

  const headers: Record<string, string> = {}
  if (candidate.userAgent) headers["User-Agent"] = candidate.userAgent
  if (candidate.referer) headers["Referer"] = candidate.referer
  try {
    const response = await providerFetch(candidate.url, { headers, signal: timeoutSignal(parentSignal, QUALITY_PROBE_TIMEOUT_MS) })
    if (!response.ok) return null
    if (!looksLikePlaylistContentType(response.headers.get("content-type"))) return null
    const contentLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(contentLength) && contentLength > MAX_MANIFEST_PROBE_BYTES) return null
    const manifestText = await readCappedText(response, MAX_MANIFEST_PROBE_BYTES)
    if (manifestText === null) return null
    return summarizeHlsMaster(manifestText)
  } catch {
    return null
  }
}

function resolveAgainst(baseUrl: string, uri: string): string | null {
  try {
    return new URL(uri, baseUrl).href
  } catch {
    return null
  }
}

function hrefIgnoringQuery(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.search = ""
    parsed.hash = ""
    return parsed.href
  } catch {
    return url
  }
}

/** Exact href match first, then match ignoring query string/fragment; never matches excludeIdx itself. */
function findCandidateIndexByUrl(targetUrl: string, candidates: SniffCandidate[], excludeIdx: number): number {
  const exactIdx = candidates.findIndex((candidate, idx) => idx !== excludeIdx && candidate.url === targetUrl)
  if (exactIdx !== -1) return exactIdx
  const targetNoQuery = hrefIgnoringQuery(targetUrl)
  return candidates.findIndex((candidate, idx) => idx !== excludeIdx && hrefIgnoringQuery(candidate.url) === targetNoQuery)
}

function audioRenditionLabel(rendition: HlsMediaRendition): string {
  const base = t("sniffer.results.audio")
  const language = rendition.language && rendition.language.toLowerCase() !== "und" ? rendition.language : null
  if (language) return `${base} · ${language.toUpperCase()}`
  if (rendition.name) return `${base} · ${rendition.name}`
  return base
}

/** Prefixes a cross-referenced variant's own chip with "Video" to contrast with "Audio · EN" rows. */
function videoVariantLabel(quality: string | null): string | null {
  const audioLabel = t("sniffer.results.audio")
  if (!quality || quality === audioLabel) return quality
  return `${t("sniffer.results.video")} · ${quality}`
}

type Phase =
  | { kind: "input"; url: string; error: string | null }
  | { kind: "progress"; stage: "loading" | "waiting" }
  | { kind: "results"; candidates: SniffCandidate[] }
  | { kind: "name"; candidate: SniffCandidate; name: string; favicon: string | null }
  | { kind: "failure"; reason: "empty" | "drm" }

function headerHtml(): string {
  return `
    <header class="flex items-start gap-3.5 shrink-0 px-3">
      <span class="icon-mark icon-mark--lg" aria-hidden="true">${ICON_WORLD}</span>
      <div class="flex flex-col gap-1 min-w-0 pt-0.5">
        <h2 id="${DIALOG_ID}-title" class="text-lg font-semibold leading-tight tracking-tight">${escapeHtml(t("sniffer.dialog.title"))}</h2>
        <p class="text-sm text-fg-3 leading-relaxed">${escapeHtml(t("sniffer.dialog.subtitle"))}</p>
      </div>
    </header>
  `
}

function candidateRowHtml(candidate: SniffCandidate, idx: number, checked: boolean, quality: string | null, masterConfirmed: boolean): string {
  const kindLabel = candidate.kind === "hls" ? t("sniffer.results.hls") : t("sniffer.results.dash")
  const showMasterBadge = candidate.isMaster || masterConfirmed
  const masterBadge = `<span data-role="master-badge" data-idx="${idx}" class="text-2xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent-soft text-accent shrink-0${showMasterBadge ? "" : " hidden"}">${escapeHtml(t("sniffer.results.master"))}</span>`
  const qualityBadge = `<span data-role="quality-chip" data-idx="${idx}" class="text-2xs font-medium px-1.5 py-0.5 rounded bg-surface-2 text-fg-2 shrink-0${quality ? "" : " hidden"}">${quality ? escapeHtml(quality) : ""}</span>`
  return `
    <div
      data-role="candidate-row"
      data-idx="${idx}"
      class="xt-picker-row flex items-center gap-3 px-3 py-2.5 rounded-xl border border-line bg-surface hover:bg-surface-2 focus-within:bg-surface-2 focus-within:border-accent has-checked:border-accent/60 has-checked:bg-accent-soft/15"
    >
      <label class="shrink-0 -m-3 p-3 inline-flex items-center justify-center rounded-lg cursor-pointer">
        <input
          type="checkbox"
          data-role="candidate-check"
          data-idx="${idx}"
          class="size-4 accent-accent"
          aria-label="${escapeHtml(t("sniffer.results.selectAria", { name: primaryPathLabel(candidate.url) }))}"
          ${checked ? "checked" : ""}
        />
      </label>
      <button
        type="button"
        data-role="candidate-btn"
        data-idx="${idx}"
        class="flex flex-col items-start flex-1 min-w-0 text-left gap-0.5 outline-none active:scale-[0.98]"
      >
        <span class="flex items-center gap-2 w-full min-w-0">
          <span class="text-2xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-2 text-fg-3 shrink-0">${escapeHtml(kindLabel)}</span>
          ${masterBadge}
          ${qualityBadge}
          <span class="text-sm font-medium truncate">${escapeHtml(primaryPathLabel(candidate.url))}</span>
        </span>
        <span class="text-xs text-fg-3 truncate w-full">${escapeHtml(secondaryLineLabel(candidate.url))}</span>
      </button>
    </div>
  `
}

function renderPhase(
  phase: Phase,
  checkedIdx: Set<number>,
  qualityByIdx: Map<number, string | null>,
  masterConfirmedIdx: Set<number>
): string {
  if (phase.kind === "input") {
    return `
      <div class="flex flex-col flex-auto min-h-0 overflow-y-auto p-5 sm:p-6 gap-5">
        ${headerHtml()}
        <label class="flex flex-col gap-2">
          <span class="text-xs font-semibold tracking-wider uppercase text-fg-3">${escapeHtml(t("sniffer.urlLabel"))}</span>
          <input
            data-role="url-input"
            type="text"
            inputmode="url"
            autocapitalize="off"
            spellcheck="false"
            placeholder="${escapeHtml(t("sniffer.urlPlaceholder"))}"
            value="${escapeHtml(phase.url)}"
            class="field-input"
          />
          ${phase.error ? `<span class="text-xs text-bad">${escapeHtml(phase.error)}</span>` : ""}
        </label>
        <footer class="flex items-center gap-3 shrink-0 mt-auto">
          <button type="button" data-role="cancel" class="btn">${escapeHtml(t("common.cancel"))}</button>
          <button type="button" data-role="start" class="btn ms-auto">${escapeHtml(t("sniffer.startBtn"))}</button>
        </footer>
      </div>
    `
  }

  if (phase.kind === "progress") {
    const message = phase.stage === "loading" ? t("sniffer.progress.loading") : t("sniffer.progress.waiting")
    return `
      <div class="flex flex-col flex-auto min-h-0 overflow-y-auto p-5 sm:p-6 gap-5">
        ${headerHtml()}
        <div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <span class="size-8 rounded-full border-2 border-line border-t-accent animate-spin" aria-hidden="true"></span>
          <p class="text-sm text-fg-2">${escapeHtml(message)}</p>
        </div>
        <footer class="flex items-center gap-3 shrink-0 mt-auto">
          <button type="button" data-role="cancel" class="btn ms-auto">${escapeHtml(t("common.cancel"))}</button>
        </footer>
      </div>
    `
  }

  if (phase.kind === "results") {
    const rows = phase.candidates
      .map((candidate, idx) =>
        candidateRowHtml(candidate, idx, checkedIdx.has(idx), qualityByIdx.get(idx) ?? null, masterConfirmedIdx.has(idx))
      )
      .join("")
    const checkedCount = checkedIdx.size
    return `
      <div class="flex flex-col flex-auto min-h-0 p-5 sm:p-6 gap-5">
        ${headerHtml()}
        <h3 class="text-sm font-semibold text-fg-2">${escapeHtml(t("sniffer.results.title"))}</h3>
        <div data-role="list" class="flex flex-col gap-2.5 overflow-y-auto min-h-0">${rows}</div>
        <footer class="flex items-center gap-3 shrink-0 mt-auto">
          <button type="button" data-role="cancel" class="btn">${escapeHtml(t("common.cancel"))}</button>
          <button
            type="button"
            data-role="add-selected"
            class="btn btn-primary ms-auto${checkedCount ? "" : " hidden"}"
          >${escapeHtml(t("sniffer.results.addSelected", { count: checkedCount }))}</button>
        </footer>
      </div>
    `
  }

  if (phase.kind === "name") {
    const safeFavicon = phase.favicon ? safeHttpUrl(phase.favicon) : null
    const faviconPreview = safeFavicon
      ? `<img src="${escapeHtml(safeFavicon)}" alt="${escapeHtml(t("sniffer.name.logoAlt"))}" onerror="this.remove()" class="size-9 rounded-lg border border-line object-contain bg-surface-2 shrink-0" />`
      : ""
    return `
      <div class="flex flex-col flex-auto min-h-0 overflow-y-auto p-5 sm:p-6 gap-5">
        ${headerHtml()}
        <label class="flex flex-col gap-2">
          <span class="text-xs font-semibold tracking-wider uppercase text-fg-3">${escapeHtml(t("sniffer.name.label"))}</span>
          <div class="flex items-center gap-2.5">
            ${faviconPreview}
            <input
              data-role="name-input"
              type="text"
              placeholder="${escapeHtml(t("sniffer.name.placeholder"))}"
              value="${escapeHtml(phase.name)}"
              class="field-input flex-1"
            />
          </div>
          <span class="text-xs text-fg-3">${escapeHtml(t("sniffer.name.hint"))}</span>
        </label>
        <footer class="flex items-center gap-3 shrink-0 mt-auto flex-wrap">
          <button type="button" data-role="back" class="btn">${escapeHtml(t("sniffer.backBtn"))}</button>
          <button type="button" data-role="save-custom" class="btn ms-auto">${escapeHtml(t("sniffer.saveToCustomBtn"))}</button>
          <button type="button" data-role="save" class="btn">${escapeHtml(t("sniffer.saveBtn"))}</button>
        </footer>
      </div>
    `
  }

  const message = phase.reason === "drm" ? t("sniffer.error.drm") : t("sniffer.error.empty")
  return `
    <div class="flex flex-col flex-auto min-h-0 overflow-y-auto p-5 sm:p-6 gap-5">
      ${headerHtml()}
      <p class="text-sm text-fg-2 py-6 text-center">${escapeHtml(message)}</p>
      <footer class="flex items-center gap-3 shrink-0 mt-auto">
        <button type="button" data-role="back" class="btn">${escapeHtml(t("sniffer.backBtn"))}</button>
        <button type="button" data-role="cancel" class="btn ms-auto">${escapeHtml(t("common.cancel"))}</button>
      </footer>
    </div>
  `
}

function candidateToSource(candidate: SniffCandidate): CustomSource {
  return {
    kind: "direct",
    url: candidate.url,
    userAgent: candidate.userAgent ?? null,
    referer: candidate.referer ?? null,
    manifestType: candidate.kind === "dash" ? "mpd" : null,
    drmScheme: null,
    licenseKey: null,
  }
}

/** Resolves once the dialog closes, saved or not. */
export function openAddFromWebsiteDialog(): Promise<void> {
  if (dialogSessionOpen) return Promise.resolve()
  const dialog = ensureDialog()
  if (!dialog) return Promise.resolve()

  dialogSessionOpen = true
  return new Promise((resolve) => {
    let resolved = false
    let phase: Phase = { kind: "input", url: "", error: null }
    let pageUrl = ""
    let lastCandidates: SniffCandidate[] = []
    let favicon: string | null = null
    const checkedIdx = new Set<number>()
    const qualityByIdx = new Map<number, string | null>()
    const pendingQualityIdx = new Set<number>()
    const masterDerivedIdx = new Set<number>()
    const masterConfirmedIdx = new Set<number>()
    let qualityAbortController: AbortController | null = null
    let resultsGeneration = 0
    let eagerProbeCount = 0
    let spatialNavCleanup: (() => void) | undefined = undefined

    const settle = () => {
      if (resolved) return
      resolved = true
      dialogSessionOpen = false
      dialog.removeEventListener("click", onClick)
      dialog.removeEventListener("mouseover", onRowInteract)
      dialog.removeEventListener("focusin", onRowInteract)
      dialog.removeEventListener("cancel", onCancel)
      dialog.removeEventListener("close", onClose)
      spatialNavCleanup?.()
      qualityAbortController?.abort()
      cancelSniff()
      try {
        if (dialog.open) dialog.close()
      } catch {}
      resolve()
    }

    const render = () => {
      dialog.innerHTML = renderPhase(phase, checkedIdx, qualityByIdx, masterConfirmedIdx)
      const focusTarget = dialog.querySelector<HTMLElement>('[data-role="url-input"], [data-role="name-input"], button')
      focusTarget?.focus()
    }

    const updateAddSelectedFooter = () => {
      const addSelectedBtn = dialog.querySelector<HTMLButtonElement>('[data-role="add-selected"]')
      if (!addSelectedBtn) return
      addSelectedBtn.textContent = t("sniffer.results.addSelected", { count: checkedIdx.size })
      addSelectedBtn.classList.toggle("hidden", checkedIdx.size === 0)
    }

    const updateQualityChip = (idx: number, quality: string | null) => {
      const chip = dialog.querySelector<HTMLElement>(`[data-role="quality-chip"][data-idx="${idx}"]`)
      if (!chip) return
      chip.textContent = quality ?? ""
      chip.classList.toggle("hidden", !quality)
    }

    const confirmMasterBadge = (idx: number) => {
      masterConfirmedIdx.add(idx)
      const badge = dialog.querySelector<HTMLElement>(`[data-role="master-badge"][data-idx="${idx}"]`)
      badge?.classList.remove("hidden")
    }

    // Master-derived chips win: a media playlist's own probe carries no resolution info.
    const applyQuality = (idx: number, quality: string | null, fromMaster: boolean) => {
      if (!fromMaster && masterDerivedIdx.has(idx)) return
      if (fromMaster) masterDerivedIdx.add(idx)
      qualityByIdx.set(idx, quality)
      updateQualityChip(idx, quality)
    }

    const crossReferenceMaster = (masterIdx: number, masterUrl: string, summary: HlsMasterSummary, candidates: SniffCandidate[]) => {
      for (const variant of summary.variants) {
        if (!variant.uri) continue
        const resolvedUrl = resolveAgainst(masterUrl, variant.uri)
        if (!resolvedUrl) continue
        const matchIdx = findCandidateIndexByUrl(resolvedUrl, candidates, masterIdx)
        if (matchIdx === -1) continue
        const label = describeHlsQuality({ isMaster: true, variants: [variant], media: [] }, t("sniffer.results.audio"))
        applyQuality(matchIdx, videoVariantLabel(label), true)
      }
      for (const rendition of summary.media) {
        if (!rendition.uri) continue
        const resolvedUrl = resolveAgainst(masterUrl, rendition.uri)
        if (!resolvedUrl) continue
        const matchIdx = findCandidateIndexByUrl(resolvedUrl, candidates, masterIdx)
        if (matchIdx === -1) continue
        applyQuality(matchIdx, audioRenditionLabel(rendition), true)
      }
    }

    const probeCandidateQuality = (idx: number, candidate: SniffCandidate, candidates: SniffCandidate[]): void => {
      if (!qualityAbortController) qualityAbortController = new AbortController()
      const controller = qualityAbortController
      const generation = resultsGeneration
      pendingQualityIdx.add(idx)
      void fetchManifestSummary(candidate, controller.signal).then((summary) => {
        pendingQualityIdx.delete(idx)
        if (controller.signal.aborted || generation !== resultsGeneration) return
        const ownLabel = summary ? describeHlsQuality(summary, t("sniffer.results.audio")) : null
        applyQuality(idx, ownLabel, false)
        if (summary?.isMaster) {
          confirmMasterBadge(idx)
          crossReferenceMaster(idx, candidate.url, summary, candidates)
        }
      })
    }

    /** Eagerly probes only the top-ranked handful of candidates; the rest wait for onRowInteract. */
    const kickoffQualityEnrichment = (candidates: SniffCandidate[]) => {
      for (const [idx, candidate] of candidates.entries()) {
        if (eagerProbeCount >= MAX_EAGER_PROBES) break
        if (candidate.kind !== "hls" || qualityByIdx.has(idx) || pendingQualityIdx.has(idx)) continue
        eagerProbeCount++
        probeCandidateQuality(idx, candidate, candidates)
      }
    }

    /** Probes a single candidate on hover/focus/select, unbounded by the eager cap. */
    const enrichCandidateOnDemand = (idx: number): void => {
      if (phase.kind !== "results") return
      const candidate = phase.candidates[idx]
      if (!candidate || candidate.kind !== "hls" || qualityByIdx.has(idx) || pendingQualityIdx.has(idx)) return
      probeCandidateQuality(idx, candidate, phase.candidates)
    }

    const runSniff = async () => {
      phase = { kind: "progress", stage: "loading" }
      render()
      try {
        const result = await sniffPage(pageUrl, {
          onProgress: (progress) => {
            if (resolved || phase.kind !== "progress") return
            phase = { kind: "progress", stage: progress.stage }
            render()
          },
        })
        if (resolved) return
        favicon = result.favicon
        if (result.candidates.length) {
          lastCandidates = result.candidates
          checkedIdx.clear()
          qualityByIdx.clear()
          pendingQualityIdx.clear()
          masterDerivedIdx.clear()
          masterConfirmedIdx.clear()
          qualityAbortController?.abort()
          qualityAbortController = null
          resultsGeneration++
          phase = { kind: "results", candidates: result.candidates }
        } else {
          phase = { kind: "failure", reason: result.drmSeen ? "drm" : "empty" }
        }
      } catch (err) {
        if (resolved) return
        log.warn("[xt:sniffer] sniffPage threw:", err)
        phase = { kind: "failure", reason: "empty" }
      }
      render()
      if (phase.kind === "results") kickoffQualityEnrichment(phase.candidates)
    }

    const startFromInput = (): void => {
      const input = dialog.querySelector<HTMLInputElement>('[data-role="url-input"]')
      const raw = (input?.value || "").trim()
      const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
      let parsed: URL | null
      try {
        parsed = new URL(normalized)
      } catch {
        parsed = null
      }
      if (!raw || !parsed || !/^https?:$/.test(parsed.protocol)) {
        phase = { kind: "input", url: raw, error: t("sniffer.error.invalidUrl") }
        render()
        return
      }
      pageUrl = parsed.href
      void runSniff()
    }

    const saveFromNamePhase = async (namePhase: Extract<Phase, { kind: "name" }>, saveBtn: HTMLButtonElement | null): Promise<void> => {
      const input = dialog.querySelector<HTMLInputElement>('[data-role="name-input"]')
      const name = (input?.value || "").trim() || hostnameOf(namePhase.candidate.url)
      if (saveBtn) saveBtn.disabled = true
      try {
        await saveSniffedStream(namePhase.candidate, {
          title: name,
          sourcePageUrl: pageUrl,
          favicon: namePhase.favicon,
        })
        toastSuccess(t("sniffer.toast.saved"))
        settle()
      } catch (err) {
        log.warn("[xt:sniffer] saveSniffedStream threw:", err)
        toastError(t("sniffer.error.saveFailed"))
        if (saveBtn) saveBtn.disabled = false
      }
    }

    const saveToCustomFromNamePhase = async (namePhase: Extract<Phase, { kind: "name" }>, saveCustomBtn: HTMLButtonElement | null): Promise<void> => {
      const input = dialog.querySelector<HTMLInputElement>('[data-role="name-input"]')
      const name = (input?.value || "").trim() || hostnameOf(namePhase.candidate.url)
      const source = candidateToSource(namePhase.candidate)
      if (saveCustomBtn) saveCustomBtn.disabled = true
      const added = await openAddToCustomDialog(source, { name, logo: namePhase.favicon })
      if (saveCustomBtn) saveCustomBtn.disabled = false
      if (added) settle()
    }

    const addSelectedToCustom = async (resultsPhase: Extract<Phase, { kind: "results" }>, addSelectedBtn: HTMLButtonElement): Promise<void> => {
      const items = [...checkedIdx]
        .sort((a, b) => a - b)
        .map((idx) => resultsPhase.candidates[idx])
        .filter((candidate): candidate is SniffCandidate => !!candidate)
        .map((candidate) => ({
          source: candidateToSource(candidate),
          init: { name: primaryPathLabel(candidate.url), logo: favicon },
        }))
      if (!items.length) return
      addSelectedBtn.disabled = true
      const added = await openAddManyToCustomDialog(items)
      addSelectedBtn.disabled = false
      if (added) settle()
    }

    const onRowInteract = (event: Event) => {
      const target = event.target as HTMLElement | null
      const row = target?.closest<HTMLElement>('[data-role="candidate-row"]')
      if (!row) return
      enrichCandidateOnDemand(Number(row.dataset.idx ?? "-1"))
    }

    const onClick = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (!target) return

      if (target.closest('[data-role="cancel"]')) {
        settle()
        return
      }

      if (target.closest('[data-role="start"]')) {
        startFromInput()
        return
      }

      const checkboxEl = target.closest<HTMLInputElement>('[data-role="candidate-check"]')
      if (checkboxEl && phase.kind === "results") {
        const idx = Number(checkboxEl.dataset.idx ?? "-1")
        if (checkboxEl.checked) checkedIdx.add(idx)
        else checkedIdx.delete(idx)
        enrichCandidateOnDemand(idx)
        updateAddSelectedFooter()
        return
      }

      const candidateBtn = target.closest<HTMLElement>('[data-role="candidate-btn"]')
      if (candidateBtn && phase.kind === "results") {
        const idx = Number(candidateBtn.dataset.idx ?? "-1")
        enrichCandidateOnDemand(idx)
        const candidate = phase.candidates[idx]
        if (candidate) {
          phase = { kind: "name", candidate, name: hostnameOf(candidate.url), favicon }
          render()
        }
        return
      }

      if (target.closest('[data-role="back"]')) {
        phase = lastCandidates.length
          ? { kind: "results", candidates: lastCandidates }
          : { kind: "input", url: pageUrl, error: null }
        render()
        if (phase.kind === "results") kickoffQualityEnrichment(phase.candidates)
        return
      }

      const saveBtn = target.closest<HTMLButtonElement>('[data-role="save"]')
      if (saveBtn && phase.kind === "name") {
        void saveFromNamePhase(phase, saveBtn)
        return
      }

      const saveCustomBtn = target.closest<HTMLButtonElement>('[data-role="save-custom"]')
      if (saveCustomBtn && phase.kind === "name") {
        void saveToCustomFromNamePhase(phase, saveCustomBtn)
        return
      }

      const addSelectedBtn = target.closest<HTMLButtonElement>('[data-role="add-selected"]')
      if (addSelectedBtn && phase.kind === "results") {
        void addSelectedToCustom(phase, addSelectedBtn)
        return
      }

      if (target === dialog) settle()
    }

    const onCancel = (event: Event) => {
      event.preventDefault()
      settle()
    }

    const onClose = () => settle()

    dialog.addEventListener("click", onClick)
    dialog.addEventListener("mouseover", onRowInteract)
    dialog.addEventListener("focusin", onRowInteract)
    dialog.addEventListener("cancel", onCancel)
    dialog.addEventListener("close", onClose)

    render()

    try {
      dialog.showModal()
    } catch (err) {
      log.warn("[xt:sniffer] showModal failed:", err)
      settle()
      return
    }

    spatialNavCleanup = attachDialogSpatialNav(dialog, {
      defaultElement: `#${DIALOG_ID} [data-role="url-input"], #${DIALOG_ID} [data-role="cancel"]`,
    })
  })
}

function ensureDialog(): HTMLDialogElement | null {
  if (typeof document === "undefined") return null
  if (dlg && document.body.contains(dlg)) return dlg
  const existing = document.getElementById(DIALOG_ID)
  if (existing instanceof HTMLDialogElement) {
    dlg = existing
    return dlg
  }
  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(36rem,calc(100vw-2rem))] max-h-[min(80dvh,36rem)]",
    "open:flex flex-col overflow-hidden",
    "backdrop:bg-black/60",
  ].join(" ")
  document.body.appendChild(node)
  dlg = node
  return dlg
}
