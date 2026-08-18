// "Surprise me" random-title picker for /movies and /series.

import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav.js"
import { makeFallback } from "@/scripts/lib/entry-card.ts"
import { escapeHtml, fmtImdbRating } from "@/scripts/lib/format.ts"
import { t } from "@/scripts/lib/i18n.js"
import { ICON_DICE, ICON_REFRESH, ICON_X } from "@/scripts/lib/icons.ts"
import { log } from "@/scripts/lib/log.js"
import {
  getProgressFraction,
  getSeriesProgressSummary,
  hasSeriesWatchedOverride,
} from "@/scripts/lib/preferences.js"

export type SurpriseKind = "vod" | "series"

export interface SurpriseEntry {
  id: number | string
  name: string
  logo?: string | null
  year?: string
  rating?: string
  category?: string
}

export interface YearBucket {
  id: string
  label: string
  min: number
  max: number
}

const YEAR_BUCKETS: YearBucket[] = [
  { id: "2020s", label: "2020s", min: 2020, max: 9999 },
  { id: "2010s", label: "2010s", min: 2010, max: 2019 },
  { id: "2000s", label: "2000s", min: 2000, max: 2009 },
  { id: "1990s", label: "1990s", min: 1990, max: 1999 },
  { id: "older", label: "older", min: 0, max: 1989 },
]

const DIALOG_ID = "xt-surprise-dialog"
const RECENT_PICK_MEMORY = 8

/** Providers put years in `year`, `releasedate` and free text, so take the first plausible 4-digit run. */
export function parseEntryYear(entry: SurpriseEntry): number | null {
  const match = /(?:19|20)\d{2}/.exec(String(entry.year || ""))
  if (!match) return null
  const year = Number(match[0])
  return year >= 1900 && year <= 2999 ? year : null
}

export function bucketForYear(year: number | null): YearBucket | null {
  if (year == null) return null
  return YEAR_BUCKETS.find((bucket) => year >= bucket.min && year <= bucket.max) ?? null
}

/** Only buckets with at least one title, so the control never offers an empty roll. */
export function availableYearBuckets(pool: SurpriseEntry[]): YearBucket[] {
  const present = new Set<string>()
  for (const entry of pool) {
    const bucket = bucketForYear(parseEntryYear(entry))
    if (bucket) present.add(bucket.id)
  }
  return YEAR_BUCKETS.filter((bucket) => present.has(bucket.id))
}

export interface SurpriseFilterOptions {
  yearBucket?: string | null
  unwatchedOnly?: boolean
  isWatched?: (entry: SurpriseEntry) => boolean
}

export function eligibleEntries(
  pool: SurpriseEntry[],
  options: SurpriseFilterOptions = {}
): SurpriseEntry[] {
  const bucket = options.yearBucket
    ? YEAR_BUCKETS.find((candidate) => candidate.id === options.yearBucket) ?? null
    : null
  return pool.filter((entry) => {
    if (bucket) {
      const year = parseEntryYear(entry)
      if (year == null || year < bucket.min || year > bucket.max) return false
    }
    if (options.unwatchedOnly && options.isWatched?.(entry)) return false
    return true
  })
}

export interface PickSurpriseOptions extends SurpriseFilterOptions {
  excludeIds?: Iterable<string>
  random?: () => number
}

/** Excluded ids are a soft preference: once every eligible title is excluded, they come back. */
export function pickSurprise(
  pool: SurpriseEntry[],
  options: PickSurpriseOptions = {}
): SurpriseEntry | null {
  const eligible = eligibleEntries(pool, options)
  if (!eligible.length) return null
  const excluded = new Set(options.excludeIds ?? [])
  const fresh = eligible.filter((entry) => !excluded.has(String(entry.id)))
  const candidates = fresh.length ? fresh : eligible
  const random = options.random ?? Math.random
  const index = Math.floor(random() * candidates.length)
  return candidates[Math.min(Math.max(index, 0), candidates.length - 1)] ?? null
}

interface StoredPrefs {
  yearBucket: string | null
  unwatchedOnly: boolean
}

function prefsKey(kind: SurpriseKind, playlistId: string): string {
  return `xt_surprise:${kind}:${playlistId}`
}

function loadPrefs(kind: SurpriseKind, playlistId: string): StoredPrefs {
  if (!playlistId) return { yearBucket: null, unwatchedOnly: false }
  try {
    const raw = localStorage.getItem(prefsKey(kind, playlistId))
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        yearBucket: typeof parsed?.yearBucket === "string" ? parsed.yearBucket : null,
        unwatchedOnly: !!parsed?.unwatchedOnly,
      }
    }
  } catch {}
  return { yearBucket: null, unwatchedOnly: false }
}

function savePrefs(kind: SurpriseKind, playlistId: string, prefs: StoredPrefs): void {
  if (!playlistId) return
  try {
    localStorage.setItem(prefsKey(kind, playlistId), JSON.stringify(prefs))
  } catch {}
}

export interface SurprisePickerConfig {
  kind: SurpriseKind
  triggerId: string
  getPool(): SurpriseEntry[]
  getPlaylistId(): string
}

export interface SurprisePickerHandle {
  open(): void
  destroy(): void
}

function bucketLabel(bucket: YearBucket): string {
  return bucket.id === "older" ? t("surprise.yearOlder") : bucket.label
}

function detailHref(kind: SurpriseKind, id: string | number, autoplay: boolean): string {
  const base = kind === "vod" ? "/movies/detail" : "/series/detail"
  return `${base}?id=${encodeURIComponent(String(id))}${autoplay ? "&autoplay=1" : ""}`
}

export function mountSurprisePicker(config: SurprisePickerConfig): SurprisePickerHandle {
  const trigger = document.getElementById(config.triggerId)
  let dialog: HTMLDialogElement | null = null
  let spatialNavCleanup: (() => void) | undefined
  let current: SurpriseEntry | null = null
  let prefs: StoredPrefs = { yearBucket: null, unwatchedOnly: false }
  const recentPicks: string[] = []

  // No episode total is known without a per-series fetch, so "started" is as far as this can go.
  const isWatched = (entry: SurpriseEntry): boolean => {
    const playlistId = config.getPlaylistId()
    if (!playlistId) return false
    if (config.kind === "vod") return getProgressFraction(playlistId, "vod", entry.id) > 0
    return !!getSeriesProgressSummary(playlistId, entry.id) ||
      hasSeriesWatchedOverride(playlistId, entry.id)
  }

  function ensureDialog(): HTMLDialogElement {
    if (dialog && document.body.contains(dialog)) return dialog
    const node = document.createElement("dialog")
    node.id = DIALOG_ID
    node.setAttribute("aria-labelledby", `${DIALOG_ID}-title`)
    node.className = [
      "fixed inset-0 m-auto rounded-2xl border border-line bg-surface text-fg p-0",
      "w-[min(30rem,calc(100vw-2rem))] max-h-[min(85dvh,36rem)]",
      "open:flex flex-col overflow-hidden",
      "backdrop:bg-black/60",
    ].join(" ")
    node.addEventListener("click", onClick)
    node.addEventListener("change", onChange)
    node.addEventListener("keydown", onKeydown)
    node.addEventListener("cancel", close)
    document.body.appendChild(node)
    dialog = node
    return node
  }

  // max-h keeps the poster from forcing overflow in phone landscape, where 85dvh is ~300px.
  const POSTER_CLASS =
    "aspect-[2/3] w-24 sm:w-32 shrink-0 rounded-xl overflow-hidden bg-surface-2 max-h-[38dvh]"

  function posterHtml(entry: SurpriseEntry): string {
    if (!entry.logo) return `<div data-role="poster" class="${POSTER_CLASS}"></div>`
    return `<img data-role="poster" src="${escapeHtml(entry.logo)}" alt="" loading="lazy" class="${POSTER_CLASS} object-cover" />`
  }

  function metaHtml(entry: SurpriseEntry): string {
    const rating = fmtImdbRating(entry.rating as any)
    const parts = [entry.year, rating, entry.category].filter(Boolean) as string[]
    if (!parts.length) return ""
    return `<p class="text-sm text-fg-3">${parts.map((part) => escapeHtml(part)).join(" · ")}</p>`
  }

  function constraintsHtml(pool: SurpriseEntry[]): string {
    if (!pool.length) return ""
    const buckets = availableYearBuckets(pool)
    const yearControl = buckets.length
      ? `
        <label class="flex items-center gap-2 text-sm">
          <span class="text-fg-3">${escapeHtml(t("surprise.year"))}</span>
          <select data-role="year" class="field-input w-auto min-w-28">
            <option value="">${escapeHtml(t("surprise.yearAny"))}</option>
            ${buckets
              .map(
                (bucket) =>
                  `<option value="${escapeHtml(bucket.id)}"${prefs.yearBucket === bucket.id ? " selected" : ""}>${escapeHtml(bucketLabel(bucket))}</option>`
              )
              .join("")}
          </select>
        </label>
      `
      : ""
    return `
      <div class="flex flex-wrap items-center gap-x-5 gap-y-3 pt-1">
        <label class="flex items-center gap-2 text-sm min-h-11">
          <input type="checkbox" data-role="unwatched" class="size-4 accent-accent"${prefs.unwatchedOnly ? " checked" : ""} />
          <span>${escapeHtml(t("surprise.unwatchedOnly"))}</span>
        </label>
        ${yearControl}
      </div>
    `
  }

  function bodyHtml(pool: SurpriseEntry[]): string {
    const playNow =
      config.kind === "vod" && current
        ? `<button type="button" data-role="play" class="btn w-full sm:w-auto">${escapeHtml(t("surprise.playNow"))}</button>`
        : ""
    const result = current
      ? `
        <div class="flex gap-4 items-start">
          ${posterHtml(current)}
          <div class="flex flex-col gap-1.5 min-w-0 pt-1">
            <p class="text-base font-semibold leading-tight">${escapeHtml(current.name)}</p>
            ${metaHtml(current)}
          </div>
        </div>
      `
      : `<p class="text-sm text-fg-3 py-6">${escapeHtml(t(pool.length ? "surprise.empty" : "surprise.emptyCatalog"))}</p>`
    const openBtn = current
      ? `<button type="button" data-role="open" class="btn btn-primary w-full sm:w-auto">${escapeHtml(t("surprise.open"))}</button>`
      : ""
    return `
      <div class="flex flex-col flex-auto min-h-0 p-5 sm:p-6 gap-5">
        <header class="flex items-start gap-3.5 shrink-0">
          <span class="icon-mark icon-mark--lg" aria-hidden="true">${ICON_DICE}</span>
          <h2 id="${DIALOG_ID}-title" class="text-lg font-semibold leading-tight tracking-tight pt-0.5">${escapeHtml(t("surprise.dialogTitle"))}</h2>
          <button
            type="button"
            data-role="close"
            aria-label="${escapeHtml(t("common.close"))}"
            class="btn ms-auto -me-1 -mt-1 w-11 px-0 shrink-0 text-fg-3"
          >${ICON_X}</button>
        </header>
        <div data-role="result" class="min-h-0 overflow-y-auto overscroll-contain">${result}</div>
        ${constraintsHtml(pool)}
        <footer class="flex flex-col sm:flex-row sm:items-center gap-3 shrink-0 mt-auto">
          <button type="button" data-role="roll" class="btn w-full sm:w-auto">
            <span class="text-base" aria-hidden="true">${ICON_REFRESH}</span>
            <span>${escapeHtml(t("surprise.rollAgain"))}</span>
          </button>
          <span class="contents sm:ms-auto sm:flex sm:items-center sm:gap-3">
            ${playNow}
            ${openBtn}
          </span>
        </footer>
      </div>
    `
  }

  function wirePoster(node: HTMLDialogElement): void {
    const poster = node.querySelector<HTMLElement>('[data-role="poster"]')
    if (!poster || !current) return
    if (poster instanceof HTMLImageElement) {
      poster.addEventListener("error", () => poster.replaceWith(fallbackPoster()), { once: true })
      return
    }
    poster.appendChild(makeFallback(current.name))
  }

  function fallbackPoster(): HTMLElement {
    const wrapper = document.createElement("div")
    wrapper.className = POSTER_CLASS
    wrapper.appendChild(makeFallback(current?.name))
    return wrapper
  }

  function render(): void {
    const node = ensureDialog()
    node.innerHTML = bodyHtml(config.getPool())
    wirePoster(node)
    if (node.open) focusPrimary(node)
  }

  function focusPrimary(node: HTMLDialogElement): void {
    node
      .querySelector<HTMLElement>('[data-role="open"], [data-role="roll"], [data-role="close"]')
      ?.focus()
  }

  function roll(): void {
    const pool = config.getPool()
    current = pickSurprise(pool, {
      yearBucket: prefs.yearBucket,
      unwatchedOnly: prefs.unwatchedOnly,
      isWatched,
      excludeIds: recentPicks,
    })
    if (current) {
      recentPicks.push(String(current.id))
      while (recentPicks.length > RECENT_PICK_MEMORY) recentPicks.shift()
    }
    log.info("[xt:surprise] rolled", {
      kind: config.kind,
      poolSize: pool.length,
      picked: current ? String(current.id) : null,
      yearBucket: prefs.yearBucket,
      unwatchedOnly: prefs.unwatchedOnly,
    })
    render()
  }

  function close(event?: Event): void {
    event?.preventDefault()
    spatialNavCleanup?.()
    spatialNavCleanup = undefined
    try {
      if (dialog?.open) dialog.close()
    } catch {}
  }

  function navigate(autoplay: boolean): void {
    if (!current) return
    close()
    window.location.href = detailHref(config.kind, current.id, autoplay)
  }

  function onClick(event: Event): void {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (target.closest('[data-role="roll"]')) return roll()
    if (target.closest('[data-role="open"]')) return navigate(false)
    if (target.closest('[data-role="play"]')) return navigate(true)
    if (target.closest('[data-role="close"]')) return close()
    if (target === dialog) close()
  }

  function onChange(event: Event): void {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (target.matches('[data-role="year"]')) {
      prefs = { ...prefs, yearBucket: (target as HTMLSelectElement).value || null }
    } else if (target.matches('[data-role="unwatched"]')) {
      prefs = { ...prefs, unwatchedOnly: (target as HTMLInputElement).checked }
    } else return
    savePrefs(config.kind, config.getPlaylistId(), prefs)
    roll()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "r" && event.key !== "R") return
    const target = event.target as HTMLElement | null
    if (target && (target.tagName === "SELECT" || target.tagName === "INPUT")) return
    event.preventDefault()
    roll()
  }

  function open(): void {
    prefs = loadPrefs(config.kind, config.getPlaylistId())
    const node = ensureDialog()
    roll()
    if (!node.open) {
      try {
        node.showModal()
      } catch (err) {
        log.warn("[xt:surprise] showModal failed:", err)
        return
      }
    }
    focusPrimary(node)
    spatialNavCleanup = attachDialogSpatialNav(node, {
      defaultElement: `#${DIALOG_ID} [data-role="open"], #${DIALOG_ID} [data-role="roll"]`,
    })
  }

  const onTriggerClick = () => open()
  trigger?.addEventListener("click", onTriggerClick)

  const onPageKeydown = (event: KeyboardEvent) => {
    if (event.key !== "r" && event.key !== "R") return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (dialog?.open) return
    const target = event.target as HTMLElement | null
    if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return
    if (document.querySelector("dialog[open]")) return
    event.preventDefault()
    open()
  }
  document.addEventListener("keydown", onPageKeydown)

  return {
    open,
    destroy() {
      trigger?.removeEventListener("click", onTriggerClick)
      document.removeEventListener("keydown", onPageKeydown)
      close()
    },
  }
}
