import { providerFetch } from "@/scripts/lib/provider-fetch.js"

const GZIP_CT = /application\/(x-)?gzip|application\/x-gunzip/i

export async function fetchAndMaybeGunzip(url: string, init?: RequestInit): Promise<string> {
  const response = await providerFetch(url, init)
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)

  const contentType = response.headers.get("content-type") || ""
  const contentDisposition = response.headers.get("content-disposition") || ""
  const lower = url.toLowerCase().split("?")[0] ?? ""
  const looksGzipped =
    lower.endsWith(".gz") || lower.endsWith(".gzip") ||
    GZIP_CT.test(contentType) ||
    /\.gz["']?(\s|$|;)/i.test(contentDisposition)

  if (!looksGzipped) return response.text()

  if (typeof DecompressionStream !== "function" || !response.body) {
    throw new Error(
      "This browser/WebView can't decompress gzipped EPG payloads. Try a provider that serves plain XML."
    )
  }

  const stream = response.body.pipeThrough(new DecompressionStream("gzip"))
  return new Response(stream).text()
}
