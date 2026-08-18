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

export const ICON_SPARKLES = wrap(
  '<path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2z" />' +
    '<path d="M16 6a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2z" />' +
    '<path d="M9 18a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z" />'
)

export const ICON_X = wrap(
  '<path d="M18 6l-12 12" />' + '<path d="M6 6l12 12" />'
)

export const ICON_INFO = wrap(
  '<path d="M12 9h.01" />' +
    '<path d="M11 12h1v4h1" />' +
    '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />'
)

export const ICON_CHEVRON_DOWN = wrap('<path d="M6 9l6 6l6 -6" />')

export const ICON_ALERT_TRIANGLE = wrap(
  '<path d="M12 9v4" />' +
    '<path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.871l-8.106 -13.534a1.914 1.914 0 0 0 -3.274 0z" />' +
    '<path d="M12 16h.01" />'
)

export const ICON_EXTERNAL_LINK = wrap(
  '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6" />' +
    '<path d="M11 13l9 -9" />' +
    '<path d="M15 4h5v5" />'
)

export const ICON_ASPECT_RATIO = wrap(
  '<path d="M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10" />' +
    '<path d="M7 12v-3h3" />' +
    '<path d="M17 12v3h-3" />'
)

export const ICON_ARROW_UP = wrap(
  '<path d="M12 5l0 14" />' + '<path d="M18 11l-6 -6" />' + '<path d="M6 11l6 -6" />'
)

export const ICON_ARROW_DOWN = wrap(
  '<path d="M12 5l0 14" />' + '<path d="M18 13l-6 6" />' + '<path d="M6 13l6 6" />'
)

export const ICON_GRIP_VERTICAL = wrap(
  '<path d="M8 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />' +
    '<path d="M8 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />' +
    '<path d="M8 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />' +
    '<path d="M14 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />' +
    '<path d="M14 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />' +
    '<path d="M14 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />'
)

export const ICON_DOWNLOAD = wrap(
  '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" />' +
    '<path d="M7 11l5 5l5 -5" />' +
    '<path d="M12 4l0 12" />'
)

export const ICON_WORLD = wrap(
  '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />' +
    '<path d="M3.6 9h16.8" />' +
    '<path d="M3.6 15h16.8" />' +
    '<path d="M11.5 3a17 17 0 0 0 0 18" />' +
    '<path d="M12.5 3a17 17 0 0 1 0 18" />'
)

export const ICON_PLAYLIST_ADD = wrap(
  '<path d="M19 8h-14" />' +
    '<path d="M5 12h9" />' +
    '<path d="M11 16h-6" />' +
    '<path d="M15 16h6" />' +
    '<path d="M18 13v6" />'
)

export const ICON_BADGE_CC = wrap(
  '<path d="M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10" />' +
    '<path d="M10 10.5a1.5 1.5 0 0 0 -3 0v3a1.5 1.5 0 0 0 3 0" />' +
    '<path d="M17 10.5a1.5 1.5 0 0 0 -3 0v3a1.5 1.5 0 0 0 3 0" />'
)

export const ICON_DOTS = wrap(
  '<path d="M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />' +
    '<path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />' +
    '<path d="M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />'
)

export const ICON_CLOCK_EDIT = wrap(
  '<path d="M21 12a9 9 0 1 0 -9.972 8.948c.32 .034 .644 .052 .972 .052" />' +
    '<path d="M12 7v5l2 2" />' +
    '<path d="M18.42 15.61a2.1 2.1 0 0 1 2.97 2.97l-3.39 3.42h-3v-3l3.42 -3.39" />'
)

export const ICON_LANGUAGE = wrap(
  '<path d="M4 5h7" />' +
    '<path d="M9 3v2c0 4.418 -2.239 8 -5 8" />' +
    '<path d="M5 9c0 2.144 2.952 3.908 6.7 4" />' +
    '<path d="M12 20l4 -9l4 9" />' +
    '<path d="M19.1 18h-6.2" />'
)

export const ICON_DICE = wrap(
  '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14" />' +
    '<path d="M8 8.5a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0" fill="currentColor" />' +
    '<path d="M15 8.5a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0" fill="currentColor" />' +
    '<path d="M15 15.5a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0" fill="currentColor" />' +
    '<path d="M8 15.5a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0" fill="currentColor" />' +
    '<path d="M11.5 12a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0" fill="currentColor" />'
)

export const ICON_REFRESH = wrap(
  '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />' +
    '<path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />'
)

export const ICON_USER = wrap(
  '<path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0" />' +
    '<path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" />'
)
