// Settings inline filter. Indexes section title + each card's text content
// at mount, re-indexes when the locale changes, and on input hides cards
// whose index doesn't contain every whitespace-split query token (AND
// match). Sections collapse when all their visible cards miss; subnav
// links resolve their miss state from whatever DOM node their href
// targets, since some point at surfaces that aren't indexed cards
// themselves (only the rows inside them are).
//
// Cards already platform-hidden (`.hidden` set by some other init code,
// e.g. desktop-only Discord card on web) are skipped from search results
// regardless of query - exposing them via search would be misleading
// because the user can't actually use them.

import { LOCALE_EVENT } from "@/scripts/lib/i18n.js"

const INPUT_ID = "settings-search-input"
const CLEAR_ID = "settings-search-clear"
const EMPTY_ID = "settings-search-empty"

interface CardEntry {
  card: HTMLElement
  key: string
}
interface SectionEntry {
  section: HTMLElement
  navLink: HTMLAnchorElement | null
  cards: CardEntry[]
}
interface SubnavLinkEntry {
  link: HTMLAnchorElement
  targetId: string
}

let sections: SectionEntry[] = []
let subnavLinks: SubnavLinkEntry[] = []
const indexByCardKey = new Map<string, string>()

function findCardsInSection(section: HTMLElement): HTMLElement[] {
  const candidates = section.querySelectorAll<HTMLElement>(
    "[data-settings-item], article, details.changelog-outer"
  )
  const cards: HTMLElement[] = []
  for (const candidate of candidates) {
    const hasAncestorCard = cards.some((existing) => existing.contains(candidate))
    if (!hasAncestorCard) cards.push(candidate)
  }
  return cards
}

function buildStructure(stack: HTMLElement): void {
  sections = []
  const sectionEls = stack.querySelectorAll<HTMLElement>(
    "section.settings-group[id]"
  )
  for (const section of sectionEls) {
    const navLink = document.querySelector<HTMLAnchorElement>(
      `.settings-nav-link[href="#${section.id}"]`
    )
    const cardEls = findCardsInSection(section)
    const cards: CardEntry[] = cardEls.map((card, index) => ({
      card,
      key: card.id || `${section.id}__card-${index}`,
    }))
    sections.push({ section, navLink, cards })
  }
}

// Subnav links may target a surface that isn't itself an indexed card (the
// index units are the [data-settings-item] rows inside it), so their
// miss state is resolved generically against the target's own subtree.
function buildSubnavLinks(): void {
  subnavLinks = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(".settings-subnav-link[href^='#']")
  )
    .map((link) => ({ link, targetId: (link.getAttribute("href") ?? "").slice(1) }))
    .filter((entry) => entry.targetId)
}

function applySubnavLinkMiss(): void {
  for (const { link, targetId } of subnavLinks) {
    const target = document.getElementById(targetId)
    if (!target || target.classList.contains("hidden")) {
      if (target) link.setAttribute("data-search-miss", "")
      else link.removeAttribute("data-search-miss")
      continue
    }
    const selfMatch = target.dataset.search === "match"
    const descendantMatch = !!target.querySelector('[data-search="match"]')
    if (selfMatch || descendantMatch) {
      link.removeAttribute("data-search-miss")
      continue
    }
    const hasCarrier = target.dataset.search !== undefined || !!target.querySelector("[data-search]")
    if (!hasCarrier) {
      const ownerSection = target.closest<HTMLElement>("section.settings-group[id]")
      if (ownerSection?.dataset.search === "miss") link.setAttribute("data-search-miss", "")
      else link.removeAttribute("data-search-miss")
      continue
    }
    link.setAttribute("data-search-miss", "")
  }
}

function buildIndex(): void {
  indexByCardKey.clear()
  for (const sectionEntry of sections) {
    const heading = sectionEntry.section.querySelector(".settings-group__title")
    const sectionTitle = heading?.textContent ?? ""
    if (sectionEntry.cards.length === 0) {
      const text = `${sectionTitle} ${sectionEntry.section.textContent ?? ""}`
        .replace(/\s+/g, " ")
        .toLowerCase()
        .trim()
      indexByCardKey.set(`${sectionEntry.section.id}__self`, text)
      continue
    }
    for (const cardEntry of sectionEntry.cards) {
      const text = `${sectionTitle} ${cardEntry.card.textContent ?? ""}`
        .replace(/\s+/g, " ")
        .toLowerCase()
        .trim()
      indexByCardKey.set(cardEntry.key, text)
    }
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function applyFilter(
  query: string,
  stack: HTMLElement,
  emptyEl: HTMLElement | null
): void {
  const tokens = tokenize(query)
  const active = tokens.length > 0

  if (active) stack.setAttribute("data-search-active", "true")
  else stack.removeAttribute("data-search-active")

  if (!active) {
    for (const sectionEntry of sections) {
      delete sectionEntry.section.dataset.search
      sectionEntry.navLink?.removeAttribute("data-search-miss")
      for (const cardEntry of sectionEntry.cards) {
        delete cardEntry.card.dataset.search
      }
    }
    for (const { link } of subnavLinks) link.removeAttribute("data-search-miss")
    if (emptyEl) emptyEl.hidden = true
    return
  }

  let visibleCount = 0
  for (const sectionEntry of sections) {
    let sectionHasMatch = false

    if (sectionEntry.cards.length === 0) {
      const indexText = indexByCardKey.get(`${sectionEntry.section.id}__self`) ?? ""
      sectionHasMatch = tokens.every((token) => indexText.includes(token))
      if (sectionHasMatch) visibleCount++
    } else {
      for (const cardEntry of sectionEntry.cards) {
        const { card } = cardEntry
        if (card.classList.contains("hidden")) {
          delete card.dataset.search
          continue
        }
        const indexText = indexByCardKey.get(cardEntry.key) ?? ""
        const matches = tokens.every((token) => indexText.includes(token))
        card.dataset.search = matches ? "match" : "miss"
        if (matches) {
          sectionHasMatch = true
          visibleCount++
          if (card instanceof HTMLDetailsElement) card.open = true
        }
      }
    }

    sectionEntry.section.dataset.search = sectionHasMatch ? "match" : "miss"
    if (sectionEntry.navLink) {
      if (sectionHasMatch) sectionEntry.navLink.removeAttribute("data-search-miss")
      else sectionEntry.navLink.setAttribute("data-search-miss", "")
    }
  }

  applySubnavLinkMiss()
  if (emptyEl) emptyEl.hidden = visibleCount > 0
}

function init(): void {
  const stack = document.querySelector<HTMLElement>(".settings-stack")
  if (!stack) return
  const input = document.getElementById(INPUT_ID) as HTMLInputElement | null
  const clearBtn = document.getElementById(CLEAR_ID) as HTMLButtonElement | null
  const emptyEl = document.getElementById(EMPTY_ID)
  if (!input) return

  buildStructure(stack)
  buildSubnavLinks()
  buildIndex()

  const apply = (): void => applyFilter(input.value, stack, emptyEl)
  const syncClearVisibility = (): void => {
    if (clearBtn) clearBtn.hidden = input.value.length === 0
  }

  let reindexQueued = false
  const scheduleReindex = (): void => {
    if (reindexQueued) return
    reindexQueued = true
    requestAnimationFrame(() => {
      reindexQueued = false
      buildIndex()
      if (input.value) apply()
    })
  }
  try {
    const hydrationObserver = new MutationObserver(scheduleReindex)
    hydrationObserver.observe(stack, { childList: true, subtree: true })
    window.setTimeout(() => {
      try { hydrationObserver.disconnect() } catch {}
    }, 3000)
  } catch {
    window.setTimeout(buildIndex, 600)
  }

  input.addEventListener("input", () => {
    syncClearVisibility()
    apply()
  })

  clearBtn?.addEventListener("click", () => {
    input.value = ""
    syncClearVisibility()
    apply()
    input.focus()
  })

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && input.value) {
      event.preventDefault()
      input.value = ""
      syncClearVisibility()
      apply()
    }
  })

  // Global `/` focuses the search input when the user is not already typing
  // somewhere else. Doesn't fight Ctrl+F / Cmd+F - the browser keeps those.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) {
      return
    }
    const target = event.target as Element | null
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return
    }
    event.preventDefault()
    input.focus()
    input.select()
  })

  document.addEventListener(LOCALE_EVENT, () => {
    buildIndex()
    if (input.value) apply()
  })

  syncClearVisibility()
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init)
} else {
  init()
}

export {}
