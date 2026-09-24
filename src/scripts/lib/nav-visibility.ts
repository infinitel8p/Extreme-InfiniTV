// Shared spatial-nav visibility check used by both the classic UI (Layout.astro) and the
// TV shell (tv/shell.ts). Element.checkVisibility() is a single native call that answers
// display:none/visibility:hidden/content-visibility without forcing the layout + style
// recalc that getBoundingClientRect() + getComputedStyle() cost per candidate element.

type CheckVisibilityFn = (options?: { visibilityProperty?: boolean }) => boolean

/** True when `elem` is visible enough to be a spatial-nav candidate. */
export function isElementVisibleForNav(elem: Element): boolean {
  // Cast through `unknown`: checkVisibility() isn't in every lib.dom.d.ts TS version, and
  // redeclaring it as optional directly on Element conflicts with the required signature
  // when it is present.
  const checkVisibility = (elem as unknown as { checkVisibility?: CheckVisibilityFn }).checkVisibility
  if (typeof checkVisibility === "function") {
    if (!checkVisibility.call(elem, { visibilityProperty: true })) return false
  } else {
    // Fallback for browsers without checkVisibility(): fixed-position elements have a null
    // offsetParent even while visible, so getClientRects() catches those.
    if ((elem as HTMLElement).offsetParent === null && elem.getClientRects().length === 0) return false
  }
  // Cheap off-screen rejection: an element scrolled entirely past the left/top edge, or
  // whose container collapsed it to nothing, still passes the checks above.
  const rect = elem.getBoundingClientRect()
  return rect.right > 0 && rect.bottom > 0
}
