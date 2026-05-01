// Text-normalization helpers shared by per-page search, category filters, and
// the cross-kind /search view.

const DIACRITICS = /[̀-ͯ]/g

export const normalize = (s: unknown): string =>
  (s || "")
    .toString()
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[|_\-()[\].,:/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

/**
 * Score a normalized string against query tokens. Returns 0 when any token
 * fails to match. Higher score = better match. Per token:
 * `100 - matchPosition` (capped) + `25` if `norm` starts with the token.
 * Summed across tokens.
 */
export function scoreNormMatch(norm: string, tokens: string[]): number {
  if (!norm || !tokens || !tokens.length) return 0
  let score = 0
  for (const token of tokens) {
    const idx = norm.indexOf(token)
    if (idx === -1) return 0
    score += 100 - (idx > 99 ? 99 : idx) + (norm.startsWith(token) ? 25 : 0)
  }
  return score
}
