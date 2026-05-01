// Shared kind metadata. Adding a fourth kind is a one-file change.

import { t } from "@/scripts/lib/i18n.js"

export type Kind = "live" | "vod" | "series" | "epg"

// English source-of-truth labels, used as the fallback when no locale is
// loaded yet (the i18n runtime falls back to English on missing keys, but the
// initial render before initI18n resolves still needs a sync value here).
export const KIND_LABEL: Record<Kind, string> = {
  live: "Live",
  vod: "Movie",
  series: "Series",
  epg: "EPG",
}

export const KIND_LABEL_PLURAL: Record<Kind, string> = {
  live: "Live TV",
  vod: "Movies",
  series: "Series",
  epg: "EPG",
}

// Locale-aware label helpers. Use these in templates and dynamic strings so
// the badge / placeholder / fallback name re-renders on locale change. The
// raw `KIND_LABEL*` maps stay exported for the few sync edge cases (e.g.
// kinds.js consumers in vanilla scripts) and as the translator's reference.
export function kindLabel(kind: Kind): string {
  return t(`kind.${kind}`)
}

export function kindLabelPlural(kind: Kind): string {
  return t(`kind.${kind}.plural`)
}

const wrap = (paths: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  paths +
  "</svg>"

export const KIND_ICON_SVG: Record<Kind, string> = {
  live: wrap(
    '<rect x="3" y="5" width="18" height="14" rx="2"/>' +
      '<path d="M8 21h8"/>' +
      '<path d="M12 17v4"/>'
  ),
  vod: wrap(
    '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<path d="M7 3v18"/>' +
      '<path d="M17 3v18"/>' +
      '<path d="M3 12h18"/>' +
      '<path d="M3 7h4"/>' +
      '<path d="M3 17h4"/>' +
      '<path d="M17 7h4"/>' +
      '<path d="M17 17h4"/>'
  ),
  series: wrap(
    '<path d="M2 8c0-1.1.9-2 2-2h2c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V8z"/>' +
      '<path d="M9 6c0-1.1.9-2 2-2h2c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2h-2c-1.1 0-2-.9-2-2V6z"/>' +
      '<path d="M16 4c0-1.1.9-2 2-2h2c1.1 0 2 .9 2 2v16c0 1.1-.9 2-2 2h-2c-1.1 0-2-.9-2-2V4z"/>'
  ),
  epg: wrap(
    '<rect x="3" y="5" width="18" height="16" rx="2"/>' +
      '<path d="M16 3v4"/>' +
      '<path d="M8 3v4"/>' +
      '<path d="M3 11h18"/>' +
      '<path d="M12 14v3"/>' +
      '<path d="M10.5 15.5h3"/>'
  ),
}

export const KIND_ORDER = ["live", "vod", "series"] as const
