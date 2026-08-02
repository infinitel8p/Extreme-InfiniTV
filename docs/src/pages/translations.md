---
layout: ../layouts/DocsLayout.astro
title: "Translations"
description: "Add or improve a locale for Extreme InfiniTV."
lede: "16 locales today. English is the source of truth. Missing keys fall back to English at runtime, so partial translations still ship."
---

## Add a new language

1. **Pick a language code.** Use a [BCP 47](https://en.wikipedia.org/wiki/IETF_language_tag) tag - the language part is usually enough (`de`, `es`, `pt-BR`).
2. **Copy the source file.** Duplicate `src/i18n/en.json` to `src/i18n/<code>.json`.
3. **Translate the values.** Keep the keys identical, only change the values. Update the `_meta` block at the top:
   ```json
   "_meta": {
     "name": "German",
     "nativeName": "Deutsch",
     "code": "de"
   }
   ```
4. **Register the loader.** Open `src/scripts/lib/i18n.ts` and add an entry to `LOCALE_LOADERS`:
   ```ts
   const LOCALE_LOADERS = {
     en: async () => enMessages,
     de: async () => (await import("@/i18n/de.json")).default,
   }
   ```
5. **Add to the metadata maps.** Same file (`i18n.ts`): add the code to `LocaleCode`, `LOCALE_META_FALLBACK`, and (if RTL) `RTL_LOCALES`.
6. **Test it.** Run `pnpm dev`, open Settings, pick your language. Check that the strings render correctly and nothing overflows the layout - some languages (German, Russian) are noticeably longer than English.
7. **Open a PR.** The translation PR template walks you through the checklist.

## Currently shipped locales

en, es, de, fr, pt-BR, it, ru, zh, ja, tr, ar, ur, nl, hi, id, pl. Arabic and Urdu render RTL.

## Conventions

- **Placeholders** use `{name}` syntax. Don't translate the placeholder name:
  ```json
  "playlist.removed": "Removed {title}"
  ```
- **Keep punctuation** consistent with the original where it matters semantically (ellipsis, question marks, sentence-ending periods).
- **Keep ampersands and HTML entities** as-is in the source - they're already rendered correctly.
- **Don't translate brand names** (`Extreme InfiniTV`, `Xtream`, `M3U`).
- **Date and time formatting** uses the operating system locale - you don't translate those.

## Updating an existing locale

If new keys appear in `en.json`, locales that don't yet have them fall back to English. The CI check (`.github/workflows/i18n-keys-check.yml`) posts a sticky comment listing missing keys when it runs on a PR. Fill them in any time and open a follow-up PR - you do not have to wait for the next release cycle.

## CI check

`.github/workflows/i18n-keys-check.yml` runs on every PR that touches `src/i18n/`. It compares each locale's key set against `en.json` and posts a summary. Missing keys are informational only (they fall back to English at runtime). JSON parse errors fail the check.

## How the runtime loads translations

- Active locale messages are cached to `localStorage["xt_locale_messages_v3"]` so the pre-paint script in `Layout.astro` can translate `[data-i18n]` elements before first paint - no FOUC. (The key's version suffix is bumped when the cache format changes; check `LOCALE_MESSAGES_STORAGE_KEY` in `i18n.ts` for the current one.)
- The `LOCALE_EVENT` (`xt:locale-changed`) fires on locale change. Svelte islands subscribe and re-render translations.
- Markup uses `data-i18n="key"` (text), `data-i18n-html="key"` (innerHTML), and `data-i18n-attr="title:key;aria-label:key2"` for attributes.

For deeper context on the i18n pipeline, see `src/scripts/lib/i18n.ts`.
