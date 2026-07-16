// "Add from website" flow: paste a page URL, sniff it via stream-sniffer.ts,
// pick a candidate stream, name it, and save as a new m3u playlist entry.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t } from "@/scripts/lib/i18n.js"
import { ICON_WORLD } from "@/scripts/lib/icons.ts"
import { toastSuccess, toastError } from "@/scripts/lib/toast.js"
import { log } from "@/scripts/lib/log.js"
import { sniffPage, cancelSniff, saveSniffedStream } from "@/scripts/lib/stream-sniffer.ts"
import type { SniffCandidate } from "@/scripts/lib/sniff-classify.ts"
import { openAddToCustomDialog } from "@/scripts/lib/add-to-custom-dialog.ts"
import type { CustomSource } from "@/scripts/lib/custom-playlist.ts"

const DIALOG_ID = "add-from-website-dialog"

let dlg: HTMLDialogElement | null = null

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" :
    ch === "<" ? "&lt;" :
    ch === ">" ? "&gt;" :
    ch === '"' ? "&quot;" : "&#39;"
  )
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
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
    "w-[min(32rem,calc(100vw-2rem))] max-h-[min(80dvh,36rem)]",
    "backdrop:bg-black/60",
  ].join(" ")
  document.body.appendChild(node)
  dlg = node
  return dlg
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

function renderPhase(phase: Phase): string {
  if (phase.kind === "input") {
    return `
      <div class="flex flex-col h-full p-5 sm:p-6 gap-5">
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
      <div class="flex flex-col h-full p-5 sm:p-6 gap-5">
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
      .map((candidate, idx) => {
        const kindLabel = candidate.kind === "hls" ? t("sniffer.results.hls") : t("sniffer.results.dash")
        const masterBadge = candidate.isMaster
          ? `<span class="text-2xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent-soft text-accent">${escapeHtml(t("sniffer.results.master"))}</span>`
          : ""
        return `
          <button
            type="button"
            data-role="candidate-btn"
            data-idx="${idx}"
            class="xt-picker-row flex items-center w-full text-left gap-3 px-3 py-2.5 rounded-xl border border-line bg-surface hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent active:scale-[0.98]"
          >
            <span class="text-2xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-2 text-fg-3 shrink-0">${escapeHtml(kindLabel)}</span>
            ${masterBadge}
            <span class="text-sm truncate">${escapeHtml(hostnameOf(candidate.url))}</span>
          </button>
        `
      })
      .join("")
    return `
      <div class="flex flex-col h-full p-5 sm:p-6 gap-5">
        ${headerHtml()}
        <h3 class="text-sm font-semibold text-fg-2">${escapeHtml(t("sniffer.results.title"))}</h3>
        <div data-role="list" class="flex flex-col gap-2.5 overflow-y-auto min-h-0">${rows}</div>
        <footer class="flex items-center gap-3 shrink-0 mt-auto">
          <button type="button" data-role="cancel" class="btn ms-auto">${escapeHtml(t("common.cancel"))}</button>
        </footer>
      </div>
    `
  }

  if (phase.kind === "name") {
    const faviconPreview = phase.favicon
      ? `<img src="${escapeHtml(phase.favicon)}" alt="${escapeHtml(t("sniffer.name.logoAlt"))}" onerror="this.remove()" class="size-9 rounded-lg border border-line object-contain bg-surface-2 shrink-0" />`
      : ""
    return `
      <div class="flex flex-col h-full p-5 sm:p-6 gap-5">
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
    <div class="flex flex-col h-full p-5 sm:p-6 gap-5">
      ${headerHtml()}
      <p class="text-sm text-fg-2 py-6 text-center">${escapeHtml(message)}</p>
      <footer class="flex items-center gap-3 shrink-0 mt-auto">
        <button type="button" data-role="back" class="btn">${escapeHtml(t("sniffer.backBtn"))}</button>
        <button type="button" data-role="cancel" class="btn ms-auto">${escapeHtml(t("common.cancel"))}</button>
      </footer>
    </div>
  `
}

/**
 * Open the "Add from website" dialog. Resolves once the dialog closes,
 * whether the user saved a stream, cancelled, or hit a dead end.
 */
export function openAddFromWebsiteDialog(): Promise<void> {
  const dialog = ensureDialog()
  if (!dialog) return Promise.resolve()

  return new Promise((resolve) => {
    let resolved = false
    let phase: Phase = { kind: "input", url: "", error: null }
    let pageUrl = ""
    let lastCandidates: SniffCandidate[] = []
    let favicon: string | null = null

    const settle = () => {
      if (resolved) return
      resolved = true
      dialog.removeEventListener("click", onClick)
      dialog.removeEventListener("cancel", onCancel)
      dialog.removeEventListener("close", onClose)
      cancelSniff()
      try {
        if (dialog.open) dialog.close()
      } catch {}
      resolve()
    }

    const render = () => {
      dialog.innerHTML = renderPhase(phase)
      const focusTarget = dialog.querySelector<HTMLElement>('[data-role="url-input"], [data-role="name-input"], button')
      focusTarget?.focus()
    }

    const runSniff = async () => {
      phase = { kind: "progress", stage: "loading" }
      render()
      try {
        const result = await sniffPage(pageUrl, {
          onProgress: (progress) => {
            if (phase.kind !== "progress") return
            phase = { kind: "progress", stage: progress.stage }
            render()
          },
        })
        favicon = result.favicon
        if (result.candidates.length) {
          lastCandidates = result.candidates
          phase = { kind: "results", candidates: result.candidates }
        } else {
          phase = { kind: "failure", reason: result.drmSeen ? "drm" : "empty" }
        }
      } catch (err) {
        log.warn("[xt:sniffer] sniffPage threw:", err)
        phase = { kind: "failure", reason: "empty" }
      }
      render()
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
      const source: CustomSource = {
        kind: "direct",
        url: namePhase.candidate.url,
        userAgent: namePhase.candidate.userAgent ?? null,
        referer: namePhase.candidate.referer ?? null,
        manifestType: namePhase.candidate.kind === "dash" ? "mpd" : null,
        drmScheme: null,
        licenseKey: null,
      }
      if (saveCustomBtn) saveCustomBtn.disabled = true
      const added = await openAddToCustomDialog(source, { name, logo: namePhase.favicon })
      if (saveCustomBtn) saveCustomBtn.disabled = false
      if (added) settle()
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

      const candidateBtn = target.closest<HTMLElement>('[data-role="candidate-btn"]')
      if (candidateBtn && phase.kind === "results") {
        const idx = Number(candidateBtn.dataset.idx ?? "-1")
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

      if (target === dialog) settle()
    }

    const onCancel = (event: Event) => {
      event.preventDefault()
      settle()
    }

    const onClose = () => settle()

    dialog.addEventListener("click", onClick)
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

    attachDialogSpatialNav(dialog, {
      defaultElement: `#${DIALOG_ID} [data-role="url-input"], #${DIALOG_ID} [data-role="cancel"]`,
    })
  })
}
