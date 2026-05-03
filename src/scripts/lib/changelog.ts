// Fetch GitHub Releases for the in-app "What's new" panel and render the
// release-note bodies. Uses `marked` so embedded HTML in release bodies
// (centered images, `<details>` blocks, badges, etc.) renders the same way
// it does on the GitHub release page rather than appearing as raw text.

import { marked } from "marked"
import DOMPurify from "dompurify"

const CACHE_KEY = "xt_changelog_cache"
const CACHE_TTL_MS = 60 * 60 * 1000

export interface ReleaseSummary {
  name?: string
  tagName: string
  publishedAt?: string
  body?: string
  htmlUrl?: string
}

interface CacheShape {
  fetchedAt: number
  releases: ReleaseSummary[]
}

export async function fetchReleases(
  repoSlug = "infinitel8p/Extreme-InfiniTV",
  limit = 10
): Promise<ReleaseSummary[]> {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached) as CacheShape
      if (
        parsed.fetchedAt &&
        Date.now() - parsed.fetchedAt < CACHE_TTL_MS &&
        Array.isArray(parsed.releases)
      ) {
        return parsed.releases.slice(0, limit)
      }
    }
  } catch {}

  const response = await fetch(
    `https://api.github.com/repos/${repoSlug}/releases?per_page=${limit}`,
    { headers: { Accept: "application/vnd.github+json" } }
  )
  if (!response.ok) throw new Error(`GitHub API ${response.status}`)
  const raw = (await response.json()) as Array<{
    name?: string
    tag_name: string
    published_at?: string
    body?: string
    html_url?: string
    draft?: boolean
    prerelease?: boolean
  }>

  const releases: ReleaseSummary[] = raw
    .filter((release) => !release.draft)
    .map((release) => ({
      name: release.name,
      tagName: release.tag_name,
      publishedAt: release.published_at,
      body: release.body,
      htmlUrl: release.html_url,
    }))

  try {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), releases } satisfies CacheShape)
    )
  } catch {}

  return releases
}

marked.setOptions({
  gfm: true,
  breaks: false,
})

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node instanceof Element && node.tagName === "A" && node.getAttribute("target") === "_blank") {
    node.setAttribute("rel", "noopener noreferrer")
  }
})

const ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "code", "del", "details", "div",
  "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd",
  "li", "ol", "p", "pre", "s", "samp", "span", "strong", "sub", "summary",
  "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]
const ALLOWED_ATTR = [
  "align", "alt", "checked", "class", "colspan", "disabled", "height",
  "href", "id", "lang", "open", "rel", "rowspan", "src", "start", "target",
  "title", "type", "width",
]

export function renderMarkdown(source: string): string {
  if (!source) return ""
  const rendered = marked.parse(source, { async: false }) as string
  return DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  })
}
