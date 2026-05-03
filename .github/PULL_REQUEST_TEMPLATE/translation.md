# Translation PR

Thanks for translating Extreme InfiniTV!

## Checklist

- [ ] Added a new file at `src/i18n/<locale>.json` (or updated an existing one).
- [ ] Filled in the `_meta` block (`name`, `nativeName`, `code`).
- [ ] Registered the loader in `src/scripts/lib/i18n.ts` (only required for **new** languages).
- [ ] Kept all keys identical to `en.json` - only the values are translated.
- [ ] Kept `{placeholder}` names untranslated.
- [ ] Verified nothing overflows the layout in `pnpm dev` (especially Settings, Sidebar, and Hub welcome card).

## Language

- Code:
- Native name:
- Translator(s):

## Optional

- Screenshots of the translated UI on a couple of routes (Hub, Settings).
- Notes on regional variants you'd want as a follow-up (e.g. `pt` and `pt-BR`).

> Missing keys fall back to English at runtime, so a partial translation is welcome - open the PR even if you haven't translated everything yet.
