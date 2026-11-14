import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { t, getActiveLocale } from "@/scripts/lib/i18n.js"
import { escapeHtml } from "@/scripts/lib/format.ts"
import { toastError, toastSuccess } from "@/scripts/lib/toast.js"
import { openExternal } from "@/scripts/lib/external-link.ts"
import { getSubtitleLangBackup, getSubtitleLangDefault } from "@/scripts/lib/app-settings.js"
import { log } from "@/scripts/lib/log.js"
import { opensubtitlesAvailable, searchSubtitles } from "@/scripts/lib/opensubtitles.ts"
import {
  subtitleResultLabel,
  toOpenSubtitlesLanguage,
  type OpenSubtitlesResult,
  type SubtitleSearchContext,
} from "@/scripts/lib/opensubtitles-params.ts"
import { SUBTITLE_LANGUAGES, subtitleLanguageName } from "@/scripts/lib/subtitle-languages.ts"
import { describeSubtitleError, setPickedSubtitle, subtitleLanguageLabel } from "@/scripts/lib/subtitle-fetch.ts"

const DIALOG_ID = "xt-subtitle-search-dialog"
const SKELETON_ROWS = 4

const PILL_CLASS = "shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide"
const ROW_CLASS =
  "xt-picker-row flex items-center w-full text-left gap-3 px-3 py-2.5 min-h-11 rounded-xl border border-line bg-surface " +
  "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent active:scale-[0.98] disabled:opacity-60"

export interface SubtitleSearchDialogOptions {
  context: SubtitleSearchContext
  onPick: (result: OpenSubtitlesResult) => Promise<void>
  pickKey?: string
}

function languageCodes(): string[] {
  const ordered: string[] = []
  const add = (code: string) => {
    const normalized = toOpenSubtitlesLanguage(code)
    if (normalized && !ordered.includes(normalized)) ordered.push(normalized)
  }
  add(getSubtitleLangDefault())
  add(getSubtitleLangBackup())
  for (const language of SUBTITLE_LANGUAGES) add(language.code)
  return ordered
}

function numberOrNull(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function skeletonRows(): string {
  return Array.from(
    { length: SKELETON_ROWS },
    (_, position) =>
      `<div class="skel h-14 rounded-xl" data-skeleton aria-hidden="true" style="--skel-enter-delay:${position * 60}ms"></div>`
  ).join("")
}

function resultRowHtml(result: OpenSubtitlesResult, position: number): string {
  const pills = [
    result.fromTrusted ? `<span class="${PILL_CLASS} text-accent border-accent">${escapeHtml(t("player.subtitles.trusted"))}</span>` : "",
    result.hearingImpaired ? `<span class="${PILL_CLASS} text-fg-3">${escapeHtml(t("player.subtitles.hearingImpaired"))}</span>` : "",
  ].join("")
  return `
    <button type="button" data-role="result" data-position="${position}" class="${ROW_CLASS}">
      <span class="${PILL_CLASS} text-fg-2">${escapeHtml(result.language)}</span>
      <span class="flex flex-col min-w-0 flex-1">
        <span class="text-sm truncate">${escapeHtml(result.release || subtitleLanguageName(result.language, getActiveLocale()))}</span>
        <span class="text-xs text-fg-3">${escapeHtml(t("player.subtitles.downloads", { count: result.downloadCount }))}</span>
      </span>
      <span class="flex items-center gap-1.5 shrink-0">${pills}</span>
    </button>
  `
}

function buildDialog(options: SubtitleSearchDialogOptions): HTMLDialogElement {
  const { context } = options
  const isEpisode = context.kind === "episode"
  const defaultCode = toOpenSubtitlesLanguage(getSubtitleLangDefault())
  const languageOptions = languageCodes()
    .map(
      (code) =>
        `<option value="${escapeHtml(code)}"${code === defaultCode ? " selected" : ""}>${escapeHtml(subtitleLanguageName(code, getActiveLocale()))}</option>`
    )
    .join("")

  const node = document.createElement("dialog")
  node.id = DIALOG_ID
  node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
  node.className = [
    "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
    "w-[min(34rem,calc(100vw-2rem))] max-h-[min(85dvh,40rem)]",
    "open:flex flex-col overflow-hidden",
    "backdrop:bg-black/70",
  ].join(" ")
  node.innerHTML = `
    <div class="flex flex-col flex-auto min-h-0 p-5 sm:p-6 gap-4">
      <h2 id="${DIALOG_ID}-title" class="text-lg font-semibold leading-tight tracking-tight shrink-0">${escapeHtml(t("player.subtitles.searchTitle"))}</h2>
      <form data-role="form" class="flex flex-col gap-3 shrink-0">
        <label class="flex flex-col gap-1.5">
          <span class="text-xs font-semibold tracking-wider uppercase text-fg-3">${escapeHtml(t("player.subtitles.query"))}</span>
          <input data-role="title" type="text" class="field-input min-h-11" value="${escapeHtml(context.title || "")}" />
        </label>
        <div class="flex flex-wrap gap-3">
          ${
            isEpisode
              ? `<label class="flex flex-col gap-1.5 w-24">
                  <span class="text-xs font-semibold tracking-wider uppercase text-fg-3">${escapeHtml(t("player.subtitles.season"))}</span>
                  <input data-role="season" type="number" min="1" inputmode="numeric" class="field-input min-h-11" value="${context.season ?? ""}" />
                </label>
                <label class="flex flex-col gap-1.5 w-24">
                  <span class="text-xs font-semibold tracking-wider uppercase text-fg-3">${escapeHtml(t("player.subtitles.episode"))}</span>
                  <input data-role="episode" type="number" min="1" inputmode="numeric" class="field-input min-h-11" value="${context.episode ?? ""}" />
                </label>`
              : ""
          }
          <label class="flex flex-col gap-1.5 flex-1 min-w-40">
            <span class="text-xs font-semibold tracking-wider uppercase text-fg-3">${escapeHtml(t("player.subtitles.language"))}</span>
            <select data-role="language" class="field-input min-h-11">${languageOptions}</select>
          </label>
        </div>
        <button type="submit" data-role="search" class="btn self-start min-h-11">${escapeHtml(t("player.subtitles.searchButton"))}</button>
      </form>
      <p data-role="status" role="status" class="text-sm text-fg-3 shrink-0 hidden"></p>
      <div data-role="results" class="flex flex-col gap-2 overflow-y-auto min-h-0 flex-auto"></div>
      <footer class="flex items-center gap-3 shrink-0 mt-auto">
        <p data-role="credit" class="text-xs text-fg-3 [&_a]:text-accent [&_a]:underline">${t("settings.subtitles.credit")}</p>
        <button type="button" data-role="close" class="btn ms-auto min-h-11">${escapeHtml(t("common.close"))}</button>
      </footer>
    </div>
  `
  return node
}

export function openSubtitleSearchDialog(options: SubtitleSearchDialogOptions): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve()
  const existing = document.getElementById(DIALOG_ID) as HTMLDialogElement | null
  if (existing?.isConnected && existing.open) return Promise.resolve()
  existing?.remove()
  if (!opensubtitlesAvailable()) {
    toastError(t("player.subtitles.error"))
    return Promise.resolve()
  }
  const dialog = buildDialog(options)
  document.body.appendChild(dialog)
  const spatialNavCleanup = attachDialogSpatialNav(dialog, { defaultElement: `#${DIALOG_ID} [data-role="title"]` })

  const query = <T extends HTMLElement>(role: string) => dialog.querySelector<T>(`[data-role="${role}"]`)!
  const titleInput = query<HTMLInputElement>("title")
  const seasonInput = dialog.querySelector<HTMLInputElement>('[data-role="season"]')
  const episodeInput = dialog.querySelector<HTMLInputElement>('[data-role="episode"]')
  const languageSelect = query<HTMLSelectElement>("language")
  const statusLine = query<HTMLElement>("status")
  const resultsBox = query<HTMLElement>("results")

  let results: OpenSubtitlesResult[] = []
  let searchController: AbortController | null = null
  let picking = false

  const setStatus = (message: string) => {
    statusLine.textContent = message
    statusLine.classList.toggle("hidden", !message)
  }

  const buildContext = (): SubtitleSearchContext => {
    const title = titleInput.value.trim()
    const base: SubtitleSearchContext = { ...options.context, title }
    if (title !== options.context.title.trim()) {
      base.tmdbId = null
      base.parentTmdbId = null
      base.imdbId = null
      base.parentImdbId = null
    }
    if (seasonInput) base.season = numberOrNull(seasonInput.value)
    if (episodeInput) base.episode = numberOrNull(episodeInput.value)
    return base
  }

  const runSearch = async () => {
    if (picking) return
    searchController?.abort()
    const controller = new AbortController()
    searchController = controller
    setStatus(t("player.subtitles.searching"))
    resultsBox.innerHTML = skeletonRows()
    try {
      const page = await searchSubtitles(buildContext(), { languages: [languageSelect.value], signal: controller.signal })
      if (controller.signal.aborted) return
      results = page.results.filter((result) => !result.machineTranslated)
      resultsBox.innerHTML = results.map((result, position) => resultRowHtml(result, position)).join("")
      setStatus(results.length ? "" : t("player.subtitles.noResults"))
    } catch (err) {
      if (controller.signal.aborted) return
      log.warn("[xt:subtitles] search failed:", err)
      results = []
      resultsBox.innerHTML = ""
      setStatus(describeSubtitleError(err))
    }
  }

  const pickResult = async (result: OpenSubtitlesResult) => {
    if (picking) return
    picking = true
    for (const row of resultsBox.querySelectorAll<HTMLButtonElement>("button")) row.disabled = true
    setStatus(t("player.subtitles.loading"))
    try {
      await options.onPick(result)
      const label = subtitleResultLabel(result, subtitleLanguageLabel)
      if (options.pickKey) {
        setPickedSubtitle(options.pickKey, { fileId: result.fileId, label, language: result.language })
      }
      toastSuccess(t("player.subtitles.loaded", { label }))
      dialog.close()
    } catch (err) {
      log.warn("[xt:subtitles] pick failed:", err)
      picking = false
      for (const row of resultsBox.querySelectorAll<HTMLButtonElement>("button")) row.disabled = false
      setStatus(describeSubtitleError(err))
    }
  }

  return new Promise((resolve) => {
    query<HTMLFormElement>("form").addEventListener("submit", (event) => {
      event.preventDefault()
      void runSearch()
    })
    resultsBox.addEventListener("click", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-role="result"]')
      const result = row ? results[Number(row.dataset.position)] : undefined
      if (result) void pickResult(result)
    })
    query("credit").addEventListener("click", (event) => {
      const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]")
      if (!anchor) return
      event.preventDefault()
      void openExternal(anchor.href)
    })
    query("close").addEventListener("click", () => dialog.close())
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close()
    })
    dialog.addEventListener("close", () => {
      searchController?.abort()
      spatialNavCleanup?.()
      dialog.remove()
      resolve()
    })

    if (typeof dialog.showModal === "function") dialog.showModal()
    else dialog.setAttribute("open", "")
    if (titleInput.value.trim()) void runSearch()
  })
}
