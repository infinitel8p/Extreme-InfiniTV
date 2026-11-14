// Text-normalization helpers shared by per-page search, category filters, and
// the cross-kind /search view.

const DIACRITICS = /[\u0300-\u036F]/g

export const normalize = (s: unknown): string =>
  (s || "")
    .toString()
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[|_\-()[\].,:/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

export type SearchToken = { text: string; wholeWord: boolean; literal?: string }

const DELIMITER_CHARS = new Set(["|", "_", "-", "(", ")", "[", "]", ".", ",", ":", "/", "\\"])

const containsDelimiter = (word: string): boolean => {
  for (const char of word) {
    if (DELIMITER_CHARS.has(char)) return true
  }
  return false
}

/** Raw query -> tokens; a word or phrase carrying a delimiter also gets a `literal` for raw-name matching. */
export function parseSearchQuery(raw: unknown): SearchToken[] {
  const text = (raw || "").toString()
  const tokens: SearchToken[] = []
  let rest = ""
  let lastIndex = 0
  const quoteRe = /"([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = quoteRe.exec(text))) {
    rest += text.slice(lastIndex, match.index) + " "
    lastIndex = quoteRe.lastIndex
    const rawPhrase = match[1]
    const phrase = normalize(rawPhrase)
    if (!phrase) continue
    const token: SearchToken = { text: phrase, wholeWord: true }
    if (containsDelimiter(rawPhrase)) {
      token.literal = rawPhrase.toLowerCase().trim().replace(/\s+/g, " ")
    }
    tokens.push(token)
  }
  rest += text.slice(lastIndex)
  rest = rest.replace(/"/g, " ")

  for (const word of rest.split(/\s+/)) {
    if (!word) continue
    const normalized = normalize(word)
    if (!normalized) continue
    if (containsDelimiter(word)) {
      tokens.push({ text: normalized, wholeWord: true, literal: word.toLowerCase() })
    } else {
      tokens.push({ text: normalized, wholeWord: false })
    }
  }
  return tokens
}

/**
 * Score a normalized string against query tokens. Returns 0 when any token
 * fails to match. Higher score = better match. Per token:
 * `100 - matchPosition` (capped) + `25` if `norm` starts with the token.
 * Summed across tokens. A token with `literal` matches `rawName` verbatim
 * (delimiters intact) when `rawName` is given, else falls back to `norm`.
 */
export function scoreNormMatch(
  norm: string,
  tokens: Array<string | SearchToken>,
  rawName?: string | null
): number {
  if (!norm || !tokens || !tokens.length) return 0
  const rawNameLower = rawName ? rawName.toLowerCase() : null
  let score = 0
  for (const token of tokens) {
    const literal = typeof token === "string" ? undefined : token.literal
    if (literal && rawNameLower) {
      const idx = rawNameLower.indexOf(literal)
      if (idx === -1) return 0
      score += 100 - (idx > 99 ? 99 : idx) + (rawNameLower.startsWith(literal) ? 25 : 0)
      continue
    }
    const wholeWord = typeof token === "string" ? false : token.wholeWord
    const text = typeof token === "string" ? token : token.text
    let idx: number
    if (wholeWord) {
      const padded = " " + norm + " "
      idx = padded.indexOf(" " + text + " ")
    } else {
      idx = norm.indexOf(text)
    }
    if (idx === -1) return 0
    score += 100 - (idx > 99 ? 99 : idx) + (norm.startsWith(text) ? 25 : 0)
  }
  return score
}

/** True when `norm` matches every token; an empty token list always matches. */
export function matchesNormQuery(
  norm: string,
  tokens: Array<string | SearchToken>,
  rawName?: string | null
): boolean {
  if (!tokens || !tokens.length) return true
  return scoreNormMatch(norm, tokens, rawName) > 0
}