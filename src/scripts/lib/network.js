const GZIP_CT = /application\/(x-)?gzip|application\/x-gunzip/i

/**
 * Fetch a URL and decompress its body if it looks like gzip. Returns the
 * raw text. Throws on HTTP errors. Falls back to plain text if the browser
 * lacks `DecompressionStream` (older WebViews) — providers that gzip aren't
 * usable on those WebViews, but we won't crash.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 */
export async function fetchAndMaybeGunzip(url, init) {
  const r = await fetch(url, init)
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`)

  const ct = r.headers.get("content-type") || ""
  const cd = r.headers.get("content-disposition") || ""
  const lower = url.toLowerCase().split("?")[0]
  const looksGzipped =
    lower.endsWith(".gz") || lower.endsWith(".gzip") ||
    GZIP_CT.test(ct) ||
    /\.gz["']?(\s|$|;)/i.test(cd)

  if (!looksGzipped) return r.text()

  if (typeof DecompressionStream !== "function" || !r.body) {
    throw new Error(
      "This browser/WebView can't decompress gzipped EPG payloads. Try a provider that serves plain XML."
    )
  }

  const ds = new DecompressionStream("gzip")
  const stream = r.body.pipeThrough(ds)
  return new Response(stream).text()
}
