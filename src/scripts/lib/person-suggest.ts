// Actor suggestion pills under the grid search input, debounced person search.
import { searchPeople, type PersonCandidate } from "@/scripts/lib/person-search.ts"
import { personFilterHref } from "@/scripts/lib/detail-chrome.ts"
import { debounce } from "@/scripts/lib/debounce.ts"
import { t } from "@/scripts/lib/i18n.js"

const SUGGEST_DEBOUNCE_MS = 300
const MIN_QUERY_LENGTH = 2
const SUGGEST_LIMIT = 3

export interface PersonSuggestOptions {
  searchEl: HTMLInputElement | null
  insertBeforeEl: HTMLElement | null
  basePath: string
  getActivePlaylistId: () => string
}

export interface PersonSuggestController {
  clear: () => void
}

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("")
}

function buildPill(candidate: PersonCandidate, basePath: string): HTMLAnchorElement {
  const pill = document.createElement("a")
  pill.href = personFilterHref(basePath, candidate.name, candidate.tmdbId)
  pill.className =
    "inline-flex items-center gap-2 rounded-full border border-line bg-surface pl-1.5 pr-3 min-h-11 " +
    "text-sm text-fg-2 shrink-0 hover:text-accent hover:border-accent " +
    "focus-visible:text-accent focus-visible:border-accent outline-none transition-colors"

  const avatar = document.createElement("span")
  avatar.className =
    "size-7 rounded-full overflow-hidden bg-surface-2 ring-1 ring-line flex items-center justify-center " +
    "text-[11px] font-medium text-fg-3 shrink-0"
  if (candidate.profileUrl) {
    const img = document.createElement("img")
    img.src = candidate.profileUrl
    img.alt = ""
    img.loading = "lazy"
    img.decoding = "async"
    img.referrerPolicy = "no-referrer"
    img.className = "h-full w-full object-cover"
    img.onerror = () => {
      img.remove()
      avatar.textContent = initialsFor(candidate.name)
    }
    avatar.appendChild(img)
  } else {
    avatar.textContent = initialsFor(candidate.name)
  }

  const label = document.createElement("span")
  label.className = "truncate max-w-40"
  label.textContent = t("list.personFilter", { name: candidate.name })

  pill.append(avatar, label)
  return pill
}

export function mountPersonSuggestStrip(options: PersonSuggestOptions): PersonSuggestController {
  const { searchEl, insertBeforeEl, basePath, getActivePlaylistId } = options
  const stripEl = document.createElement("div")
  stripEl.className = "flex items-center gap-2 shrink-0 px-1 overflow-x-auto"
  stripEl.setAttribute("hidden", "")
  insertBeforeEl?.insertAdjacentElement("beforebegin", stripEl)

  let requestToken = 0

  function clear(): void {
    requestToken++
    stripEl.replaceChildren()
    stripEl.setAttribute("hidden", "")
  }

  async function runSearch(query: string): Promise<void> {
    const playlistId = getActivePlaylistId()
    if (!playlistId) {
      clear()
      return
    }
    const runToken = ++requestToken
    const candidates = await searchPeople(playlistId, query, SUGGEST_LIMIT)
    if (runToken !== requestToken) return
    if (!candidates.length) {
      clear()
      return
    }
    stripEl.replaceChildren(...candidates.map((candidate) => buildPill(candidate, basePath)))
    stripEl.removeAttribute("hidden")
    window.SpatialNavigation?.makeFocusable?.()
  }

  const debouncedSearch = debounce((query: string) => {
    runSearch(query).catch(() => clear())
  }, SUGGEST_DEBOUNCE_MS)

  searchEl?.addEventListener("input", () => {
    const query = searchEl.value.trim()
    if (query.length < MIN_QUERY_LENGTH) {
      clear()
      return
    }
    debouncedSearch(query)
  })

  return { clear }
}
