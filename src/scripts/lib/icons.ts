// Canonical Tabler Icons (outline) as SVG strings, for use inside JS-built
// DOM where we can't render the @tabler/icons-svelte components.
//
// Paths copied verbatim from upstream Tabler. Icons render at 1em × 1em so
// they scale with the surrounding font-size - set Tailwind text-* on the
// parent (or a wrapping span) to control size.
//
// If you need a new icon, check `node_modules/@tabler/icons-svelte/icons/<name>.svelte`
// or https://tabler.io/icons.

const wrap = (paths: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  paths +
  "</svg>"

export const ICON_TRASH = wrap(
  '<path d="M4 7l16 0" />' +
    '<path d="M10 11l0 6" />' +
    '<path d="M14 11l0 6" />' +
    '<path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" />' +
    '<path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" />'
)

export const ICON_PENCIL = wrap(
  '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" />' +
    '<path d="M13.5 6.5l4 4" />'
)

export const ICON_CHECK = wrap('<path d="M5 12l5 5l10 -10" />')

export const ICON_X = wrap(
  '<path d="M18 6l-12 12" />' + '<path d="M6 6l12 12" />'
)
