// Shared movie/series detail-page chrome: back-link, cast rail, similar rail, language pills.

import { t, getActiveLocale } from "@/scripts/lib/i18n.js"
import { tmdbImageUrl, TMDB_PROFILE_SIZE } from "@/scripts/lib/tmdb.ts"
import { ICON_USER } from "@/scripts/lib/icons.ts"
import { buildEntryCard, type EntryKind, type EntryLike } from "@/scripts/lib/entry-card.ts"
import {
  parseNamePrefix,
  languageTagLabel,
  effectivePreferredTags,
  prefixQualityTokens,
} from "@/scripts/lib/language-tags.ts"
import { getContentLanguage, getLanguageGroupingEnabled } from "@/scripts/lib/app-settings.js"
import { getGroupLanguages } from "@/scripts/lib/preferences.js"
import type { CatalogGroupingIndex, GroupableEntry } from "@/scripts/lib/language-groups.ts"

// ----------------------------
// Navigation / skeleton
// ----------------------------

/** Real back() instead of a push navigation so bfcache and the grid's own back-navigation restore both work. */
export function wireDetailBackLink(backLink: HTMLElement | null, gridPath: string): void {
  backLink?.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    if (history.length <= 1) return
    let referrerUrl
    try {
      referrerUrl = new URL(document.referrer)
    } catch {
      return
    }
    if (referrerUrl.origin !== location.origin || referrerUrl.pathname !== gridPath) return
    event.preventDefault()
    history.back()
  })
}

export function setDetailSkeletonVisible(refs: {
  titleEl: HTMLElement | null
  metaEl: HTMLElement | null
  plotEl: HTMLElement | null
}): void {
  document.querySelectorAll("[data-detail-skeleton]").forEach((el) => el.removeAttribute("hidden"))
  refs.titleEl?.setAttribute("hidden", "")
  refs.metaEl?.setAttribute("hidden", "")
  refs.plotEl?.setAttribute("hidden", "")
}

// ----------------------------
// Pure text helpers
// ----------------------------

/** Xtream `youtube_trailer` can be a bare 11-char video id or a full URL; "" if neither. */
export function youtubeUrlFromTrailer(trailer: unknown): string {
  if (!trailer) return ""
  const value = String(trailer).trim()
  if (!value) return ""
  if (/^https?:\/\//i.test(value)) return value
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return `https://www.youtube.com/watch?v=${value}`
  }
  return ""
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
])

/** Extracts the 11-char video id from a bare id or any recognized YouTube URL shape; "" otherwise. */
export function youtubeKeyFromUrl(url: string): string {
  const value = String(url ?? "").trim()
  if (!value) return ""
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return ""
  }
  if (!/^https?:$/i.test(parsed.protocol)) return ""
  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return ""

  if (parsed.hostname.toLowerCase() === "youtu.be") {
    const key = parsed.pathname.slice(1)
    return /^[a-zA-Z0-9_-]{11}$/.test(key) ? key : ""
  }

  const watchKey = parsed.searchParams.get("v")
  if (watchKey && /^[a-zA-Z0-9_-]{11}$/.test(watchKey)) return watchKey

  const pathMatch = parsed.pathname.match(/\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]{11})/)
  return pathMatch ? pathMatch[1] : ""
}

/** Strips a recognized language prefix for display only; the stored name keeps the raw provider name. */
export function displayTitle(name: string | null | undefined): string | null | undefined {
  if (!name) return name
  const { tag, rest } = parseNamePrefix(name)
  return tag != null ? rest : name
}

/** Providers sometimes send a full release date instead of a bare year; show year-only. */
export function extractDisplayYear(value: unknown): string {
  const raw = String(value).trim()
  const match = raw.match(/(19|20)\d{2}/)
  return match ? match[0] : raw
}

export function escapeDetailText(text: unknown): string {
  const div = document.createElement("div")
  div.textContent = String(text)
  return div.innerHTML
}

export function setFactRow(id: string, value: string): void {
  const row = document.getElementById(id)
  if (!row) return
  if (!value) {
    row.setAttribute("hidden", "")
    return
  }
  const valueEl = row.querySelector('[data-role="fact-value"]')
  if (valueEl) valueEl.textContent = value
  row.removeAttribute("hidden")
}

/** tmdbPersonId is omitted for the provider-only chip row (no TMDb id to carry). */
export function personFilterHref(basePath: string, name: string, tmdbPersonId: number | null): string {
  const params = new URLSearchParams({ person: name })
  if (tmdbPersonId) params.set("personId", String(tmdbPersonId))
  return `${basePath}?${params.toString()}`
}

/** Dedup preserving order, director first, since IPTV provider casts often repeat a name. */
export function providerPeopleNames(peopleInfo: { directorName: string | null; castNames: string[] }): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const add = (name: string | null | undefined) => {
    const trimmed = (name || "").trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    names.push(trimmed)
  }
  add(peopleInfo.directorName)
  for (const name of peopleInfo.castNames) add(name)
  return names
}

// ----------------------------
// TMDb enrichment patches
// ----------------------------

export function patchDirectorElement(
  directorEl: HTMLElement | null,
  director: string | null | undefined,
  tmdbPersonId: number | null,
  buildPersonHref: (name: string, tmdbPersonId: number | null) => string
): void {
  if (!directorEl || !director) return
  directorEl.textContent = ""
  directorEl.append(`${t("detail.director")}: `)
  if (tmdbPersonId) {
    const link = document.createElement("a")
    link.href = buildPersonHref(director, tmdbPersonId)
    link.textContent = director
    link.className =
      "text-fg-2 hover:text-accent focus-visible:text-accent outline-none " +
      "rounded focus-visible:ring-1 focus-visible:ring-accent"
    directorEl.appendChild(link)
  } else {
    directorEl.append(director)
  }
  directorEl.removeAttribute("hidden")
}

export function patchTaglineElement(taglineEl: HTMLElement | null, tagline: string | null | undefined): void {
  if (!taglineEl || !tagline) return
  taglineEl.textContent = tagline
  taglineEl.removeAttribute("hidden")
}

// Defensive: profilePath may be a raw TMDb path rather than an already-mapped full URL.
function castProfileUrl(profilePath: string | null | undefined): string | null {
  if (!profilePath) return null
  return profilePath.startsWith("http") ? profilePath : tmdbImageUrl(profilePath, TMDB_PROFILE_SIZE)
}

export interface CastMemberLike {
  name: string
  character: string
  profilePath: string | null
  tmdbPersonId: number | null
}

export function renderCastList(opts: {
  castSection: HTMLElement | null
  castListEl: HTMLElement | null
  cast: CastMemberLike[]
  buildPersonHref: (name: string, tmdbPersonId: number | null) => string
}): void {
  const { castSection, castListEl, cast, buildPersonHref } = opts
  if (!castSection || !castListEl || !cast.length) return
  castListEl.replaceChildren()
  for (const member of cast) {
    const interactive = !!member.tmdbPersonId
    const card = document.createElement(interactive ? "a" : "div")
    card.className = "flex flex-col items-center gap-1.5 w-20 sm:w-24 shrink-0 snap-start text-center rounded-lg outline-none"
    if (interactive) {
      ;(card as HTMLAnchorElement).href = buildPersonHref(member.name, member.tmdbPersonId)
      card.classList.add("group", "cursor-pointer", "focus-visible:ring-1", "focus-visible:ring-accent")
    }

    const photoWrap = document.createElement("div")
    photoWrap.className =
      "size-16 sm:size-20 rounded-full overflow-hidden bg-surface-2 ring-1 ring-line flex items-center justify-center text-fg-3"
    const profileUrl = castProfileUrl(member.profilePath)
    if (profileUrl) {
      const img = document.createElement("img")
      img.src = profileUrl
      img.alt = ""
      img.loading = "lazy"
      img.decoding = "async"
      img.referrerPolicy = "no-referrer"
      img.className = "h-full w-full object-cover"
      img.onerror = () => {
        img.remove()
        photoWrap.innerHTML = ICON_USER
      }
      photoWrap.appendChild(img)
    } else {
      photoWrap.innerHTML = ICON_USER
    }

    const info = document.createElement("div")
    info.className = "w-full"
    const nameEl = document.createElement("div")
    nameEl.className =
      "truncate text-sm font-medium text-fg" +
      (interactive ? " group-hover:text-accent group-focus-visible:text-accent transition-colors" : "")
    nameEl.textContent = member.name
    const characterEl = document.createElement("div")
    characterEl.className = "truncate text-xs text-fg-3"
    characterEl.textContent = member.character
    info.append(nameEl, characterEl)

    card.append(photoWrap, info)
    castListEl.appendChild(card)
  }
  castSection.removeAttribute("hidden")
}

export function renderProviderPeopleChipRow(opts: {
  row: HTMLElement | null
  listEl: HTMLElement | null
  names: string[]
  buildPersonHref: (name: string, tmdbPersonId: number | null) => string
}): void {
  const { row, listEl, names, buildPersonHref } = opts
  if (!row || !listEl) return
  if (!names.length) {
    row.setAttribute("hidden", "")
    listEl.replaceChildren()
    return
  }
  listEl.replaceChildren()
  for (const name of names.slice(0, 8)) {
    const chip = document.createElement("a")
    chip.href = buildPersonHref(name, null)
    chip.className =
      "rounded-full border border-line px-2 py-0.5 text-xs text-fg-2 " +
      "hover:text-accent hover:border-accent focus-visible:text-accent focus-visible:border-accent outline-none transition-colors"
    chip.textContent = name
    listEl.appendChild(chip)
  }
  row.removeAttribute("hidden")
}

// ----------------------------
// Similar rail
// ----------------------------

export function renderSimilarRail(opts: {
  section: HTMLElement | null
  listEl: HTMLElement | null
  matches: EntryLike[]
  kind: EntryKind
  activePlaylistId: string
  detailHrefBase: string
  fallbackTitleKey: string
}): void {
  const { section, listEl, matches, kind, activePlaylistId, detailHrefBase, fallbackTitleKey } = opts
  if (!section || !listEl || !matches.length) return
  listEl.replaceChildren()
  matches.forEach((entry, idx) => {
    const card = buildEntryCard({
      entry,
      idx,
      kind,
      activePlaylistId,
      detailHref: (e) => `${detailHrefBase}?id=${encodeURIComponent(e.id)}`,
      fallbackTitle: (e) => t(fallbackTitleKey, { id: e.id }),
      metaText: (e) => {
        const parts = []
        if (e.year) parts.push(e.year)
        if (e.category) parts.push(e.category)
        return parts.join(" • ")
      },
    })
    const cardWrap = document.createElement("div")
    cardWrap.className = "w-32 sm:w-36 lg:w-40 shrink-0 snap-start"
    cardWrap.appendChild(card)
    listEl.appendChild(cardWrap)
  })
  section.removeAttribute("hidden")
}

// ----------------------------
// Language pills
// ----------------------------

export type GroupingIndexLookup = (playlistId: string | null, catalog: GroupableEntry[]) => CatalogGroupingIndex

export function groupKeyForCatalog(
  activePlaylistId: string,
  catalog: GroupableEntry[] | undefined,
  getGroupingIndexFor: GroupingIndexLookup
): ((entry: { id: string | number }) => string) | undefined {
  if (!activePlaylistId || !catalog?.length) return undefined
  const index = getGroupingIndexFor(activePlaylistId, catalog)
  return (entry) => index.keyByEntryId.get(Number(entry.id)) ?? `e:${entry.id}`
}

/** One pill per language+quality variant of the current item's group; hidden below 2 pills or when grouping is off. */
export function renderLanguagePills(opts: {
  langsEl: HTMLElement | null
  item: { id: number; name: string } | null
  kind: EntryKind
  activePlaylistId: string
  catalog: GroupableEntry[] | undefined
  getGroupingIndexFor: GroupingIndexLookup
  detailHrefBase: string
}): void {
  const { langsEl, item, kind, activePlaylistId, catalog, getGroupingIndexFor, detailHrefBase } = opts
  if (!langsEl || !item || !activePlaylistId || !catalog?.length) return
  if (!getLanguageGroupingEnabled() || !getGroupLanguages(activePlaylistId, kind)) {
    langsEl.setAttribute("hidden", "")
    langsEl.replaceChildren()
    return
  }

  const index = getGroupingIndexFor(activePlaylistId, catalog)
  const groupKey = index.keyByEntryId.get(item.id)
  const groupInfo = groupKey ? index.groupsByKey.get(groupKey) : null
  if (!groupInfo || groupInfo.entryIds.length < 2) {
    langsEl.setAttribute("hidden", "")
    langsEl.replaceChildren()
    return
  }

  const groupEntryIdSet = new Set(groupInfo.entryIds)
  const nameByEntryId = new Map<number, string>()
  for (const entry of catalog) {
    if (!groupEntryIdSet.has(entry.id)) continue
    nameByEntryId.set(entry.id, entry.name)
    if (nameByEntryId.size === groupEntryIdSet.size) break
  }

  const entryIdsByTag = new Map<string | null, number[]>()
  for (const entryId of groupInfo.entryIds) {
    const tag = index.tagByEntryId.get(entryId) ?? null
    const bucket = entryIdsByTag.get(tag)
    if (bucket) bucket.push(entryId)
    else entryIdsByTag.set(tag, [entryId])
  }

  // Tag order: current variant first, then content-language preference, then remaining tags; null-tag last.
  const currentTag = index.tagByEntryId.get(item.id) ?? null
  const orderedTags: (string | null)[] = []
  const addTagOnce = (tag: string | null) => {
    if (tag != null && !orderedTags.includes(tag)) orderedTags.push(tag)
  }
  addTagOnce(currentTag)
  for (const tag of effectivePreferredTags(getContentLanguage(), getActiveLocale())) addTagOnce(tag)
  for (const tag of groupInfo.tags) addTagOnce(tag)
  orderedTags.push(null)

  const locale = getActiveLocale()
  const pillModels: { entryId: number; text: string }[] = []
  for (const tag of orderedTags) {
    const bucket = entryIdsByTag.get(tag)
    if (!bucket) continue

    // Entries with the same quality-token list are duplicates; keep the first-seen one per list.
    const survivorByQualityKey = new Map<string, { entryId: number; qualityTokens: string[] }>()
    for (const entryId of bucket) {
      const qualityTokens = prefixQualityTokens(nameByEntryId.get(entryId) || "")
      const qualityKey = qualityTokens.join("-")
      const existingSurvivor = survivorByQualityKey.get(qualityKey)
      // Prefer the current entry as survivor so the aria-current pill never disappears.
      if (!existingSurvivor || entryId === item.id) {
        survivorByQualityKey.set(qualityKey, { entryId, qualityTokens })
      }
    }

    const variants = [...survivorByQualityKey.values()].sort(
      (firstVariant, secondVariant) => firstVariant.qualityTokens.length - secondVariant.qualityTokens.length
    )
    const label = tag != null ? languageTagLabel(tag, locale) : t("detail.lang.unknown")
    for (const variant of variants) {
      const text = variant.qualityTokens.length ? `${label} · ${variant.qualityTokens.join(" ")}` : label
      pillModels.push({ entryId: variant.entryId, text })
    }
  }

  if (pillModels.length < 2) {
    langsEl.setAttribute("hidden", "")
    langsEl.replaceChildren()
    return
  }

  langsEl.replaceChildren()
  for (const { entryId, text } of pillModels) {
    const isCurrent = entryId === item.id
    const pill = document.createElement(isCurrent ? "span" : "a")
    pill.className =
      "rounded-full border px-2 py-0.5 text-xs outline-none transition-colors " +
      (isCurrent
        ? "border-accent text-accent"
        : "border-line text-fg-2 hover:text-accent hover:border-accent focus-visible:text-accent focus-visible:border-accent")
    pill.textContent = text
    if (isCurrent) pill.setAttribute("aria-current", "true")
    else (pill as HTMLAnchorElement).href = `${detailHrefBase}?id=${encodeURIComponent(entryId)}`
    langsEl.appendChild(pill)
  }

  langsEl.removeAttribute("hidden")
}
