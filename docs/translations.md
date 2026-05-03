# Translating Extreme InfiniTV

Translations are community-driven. English is the source of truth - any key
missing from another locale falls back to English at runtime, so a partial
translation still works in production.

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
5. **Test it.** Run `pnpm dev`, open Settings, pick your language. Check that the strings render correctly and nothing overflows the layout - some languages (German, Russian) are noticeably longer than English.
6. **Open a PR.** See the translation PR template - it walks you through the checklist.

## Conventions

- **Placeholders** use `{name}` syntax. Don't translate the placeholder name. Example:
  ```json
  "playlist.removed": "Removed {title}"
  ```
- **Keep punctuation** consistent with the original where it matters semantically (ellipsis, question marks, sentence-ending periods).
- **Keep ampersands and HTML entities** as-is in the source - they're already rendered correctly.
- **Don't translate brand names** (`Extreme InfiniTV`, `Xtream`, `M3U`).
- **Date and time formatting** uses the operating system locale - you don't translate those.

## Updating an existing language

If new keys appear in `en.json`, locales that don't yet have them fall back to English. The CI check posts a comment listing missing keys when it runs on a PR. Fill them in any time and open a follow-up PR.

## CI check

`.github/workflows/i18n-keys-check.yml` runs on every PR that touches `src/i18n/`. It compares each locale's key set against `en.json` and posts a summary. Missing keys are fine (they fall back to English) - JSON parse errors fail the check.
