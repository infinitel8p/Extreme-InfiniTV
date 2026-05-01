// Tiny i18n runtime. English is the source of truth - any missing key in a
// non-English locale falls back to English so a half-finished translation
// still works in production.
//
// Locale JSONs live in `src/i18n/<locale>.json`. To add a new language, copy
// `en.json` to `<code>.json`, translate values, and register the loader in
// the `LOCALE_LOADERS` table below. See `docs/translations.md`.

import enMessages from "@/i18n/en.json"

export type LocaleCode =
  | "en"
  | "es"
  | "de"
  | "fr"
  | "pt-BR"
  | "it"
  | "ru"
  | "zh"
  | "ja"

export type LocaleMessages = Record<string, string>

interface LocaleMeta {
  code: string
  name: string
  nativeName: string
}

const LOCALE_LOADERS: Record<LocaleCode, () => Promise<LocaleMessages>> = {
  en: async () => enMessages as unknown as LocaleMessages,
  es: async () => (await import("@/i18n/es.json")).default as unknown as LocaleMessages,
  de: async () => (await import("@/i18n/de.json")).default as unknown as LocaleMessages,
  fr: async () => (await import("@/i18n/fr.json")).default as unknown as LocaleMessages,
  "pt-BR": async () => (await import("@/i18n/pt-BR.json")).default as unknown as LocaleMessages,
  it: async () => (await import("@/i18n/it.json")).default as unknown as LocaleMessages,
  ru: async () => (await import("@/i18n/ru.json")).default as unknown as LocaleMessages,
  zh: async () => (await import("@/i18n/zh.json")).default as unknown as LocaleMessages,
  ja: async () => (await import("@/i18n/ja.json")).default as unknown as LocaleMessages,
}

const LOCALE_META_FALLBACK: Record<LocaleCode, { name: string; nativeName: string }> = {
  en: { name: "English", nativeName: "English" },
  es: { name: "Spanish", nativeName: "Español" },
  de: { name: "German", nativeName: "Deutsch" },
  fr: { name: "French", nativeName: "Français" },
  "pt-BR": { name: "Portuguese (Brazil)", nativeName: "Português (Brasil)" },
  it: { name: "Italian", nativeName: "Italiano" },
  ru: { name: "Russian", nativeName: "Русский" },
  zh: { name: "Chinese (Simplified)", nativeName: "中文（简体）" },
  ja: { name: "Japanese", nativeName: "日本語" },
}

function isLocaleCode(code: string): code is LocaleCode {
  return code in LOCALE_LOADERS
}

const LOCALE_STORAGE_KEY = "xt_locale"
const LOCALE_CHANGED_EVENT = "xt:locale-changed"

const cache = new Map<string, LocaleMessages>()
cache.set("en", enMessages as unknown as LocaleMessages)

let activeCode = "en"
let activeMessages: LocaleMessages = enMessages as unknown as LocaleMessages

/**
 * Translate a key with optional `{name}` placeholders. Returns English when
 * the active locale lacks the key, and returns the key itself as a last
 * resort so missing strings stay visible (rather than rendering as empty).
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const template =
    activeMessages[key] ??
    (enMessages as unknown as LocaleMessages)[key] ??
    key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value == null ? match : String(value)
  })
}

export function getActiveLocale(): string {
  return activeCode
}

export function getAvailableLocales(): LocaleMeta[] {
  return Object.keys(LOCALE_LOADERS).map((code) => {
    const fallback = LOCALE_META_FALLBACK[code]
    return {
      code,
      name: fallback?.name ?? code,
      nativeName: fallback?.nativeName ?? code,
    }
  })
}

function readPersistedLocale(): string | null {
  try {
    return typeof localStorage !== "undefined"
      ? localStorage.getItem(LOCALE_STORAGE_KEY)
      : null
  } catch {
    return null
  }
}

function writePersistedLocale(code: string | null): void {
  try {
    if (typeof localStorage === "undefined") return
    if (code) localStorage.setItem(LOCALE_STORAGE_KEY, code)
    else localStorage.removeItem(LOCALE_STORAGE_KEY)
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

function detectLocale(): LocaleCode {
  const persisted = readPersistedLocale()
  if (persisted && isLocaleCode(persisted)) return persisted
  if (typeof navigator === "undefined") return "en"
  for (const tag of navigator.languages || [navigator.language || ""]) {
    if (!tag) continue
    const lower = tag.toLowerCase()
    if (isLocaleCode(lower)) return lower
    const base = lower.split("-")[0]!
    if (isLocaleCode(base)) return base
  }
  return "en"
}

export async function setLocale(code: string | null): Promise<void> {
  // null means "reset to auto-detect": clear the override first so detectLocale
  // picks from navigator.languages, then resolve and proceed with that.
  if (code === null) {
    writePersistedLocale(null)
    code = detectLocale()
  }
  if (!isLocaleCode(code)) code = "en"
  if (!cache.has(code)) {
    const loader = LOCALE_LOADERS[code]!
    cache.set(code, await loader())
  }
  activeCode = code
  activeMessages = cache.get(code)!
  // Persistence policy: only write the key when the chosen locale differs from
  // what auto-detect would pick *and* there isn't already a stored override.
  // This keeps localStorage clean for users who never deviate from their
  // browser default. NB: detectLocale() reads readPersistedLocale() internally,
  // so the order matters - we evaluate detectLocale() with the storage in
  // whatever state it was after the (code === null) branch above.
  const matchesAutoDetect = code === detectLocale() && !readPersistedLocale()
  writePersistedLocale(matchesAutoDetect ? null : code)
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", code)
    applyI18nDOM()
    document.dispatchEvent(new CustomEvent(LOCALE_CHANGED_EVENT, { detail: { code } }))
  }
}

/**
 * Replace text content of any `[data-i18n="key"]` element with the translated
 * string. Also handles `[data-i18n-html="key"]` (inserts raw HTML, for strings
 * that need inline tags like `<a>` or `<strong>`) and
 * `[data-i18n-attr="attrName:key;attrName:key"]` for attributes (aria-label,
 * title, placeholder). Astro pages render at build time so they ship the
 * English string baked in - this hook swaps the visible text after hydration
 * and on every locale change.
 *
 * Trust contract for `data-i18n-html`: locale JSON values are author-controlled
 * (committed to this repo by maintainers / translators reviewing PRs), not
 * end-user input, so `innerHTML =` is safe here. Translators must keep values
 * limited to plain text plus the inline markup needed for layout (e.g. `<a>`,
 * `<strong>`, `<br>`). Never accept locale data from a runtime source - if
 * that ever changes, replace this with a sanitizer.
 */
export function applyI18nDOM(root: ParentNode = document): void {
  if (typeof document === "undefined") return
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n
    if (key) el.textContent = t(key)
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-html]")) {
    const key = el.dataset.i18nHtml
    if (key) el.innerHTML = t(key)
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-attr]")) {
    const spec = el.dataset.i18nAttr || ""
    for (const pair of spec.split(";")) {
      const [attr, key] = pair.split(":").map((part) => part.trim())
      if (attr && key) el.setAttribute(attr, t(key))
    }
  }
}

let _initPromise: Promise<void> | null = null

/**
 * Initialise i18n at app boot. Idempotent: callers across modules share a
 * single in-flight promise. Page modules that read translations
 * synchronously should `await initI18n()` first to avoid an English flash
 * before the locale JSON resolves.
 */
export function initI18n(): Promise<void> {
  if (!_initPromise) {
    const code = detectLocale()
    _initPromise = setLocale(code === "en" ? "en" : code)
  }
  return _initPromise
}

export const LOCALE_EVENT = LOCALE_CHANGED_EVENT
