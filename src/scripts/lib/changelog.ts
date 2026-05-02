// Fetch GitHub Releases for the in-app "What's new" panel and render the
// release-note bodies. Uses `marked` so embedded HTML in release bodies
// (centered images, `<details>` blocks, badges, etc.) renders the same way
// it does on the GitHub release page rather than appearing as raw text.

import { marked } from "marked"

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

/**
 * Render a GitHub release body to HTML. Marked handles GFM markdown plus
 * the inline HTML blocks GitHub's release UI uses (centered hero image,
 * `<details>`/`<summary>` collapsibles, badge tables). Input comes from
 * the project's own GitHub releases via the API; the threat model assumes
 * an attacker would need to compromise the maintainer's GitHub account
 * before XSS in this view becomes the worst problem.
 */
export function renderMarkdown(source: string): string {
  if (!source) return ""
  return marked.parse(source) as string
}
