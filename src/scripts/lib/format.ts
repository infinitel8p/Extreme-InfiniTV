const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}

export function fmtAge(ts: number | null | undefined): string | null {
  if (!ts) return null
  const ms = Date.now() - ts
  if (ms < 60_000) return "just now"
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n || n < 0) return "0 B"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function fmtImdbRating(raw: unknown): string {
  if (raw == null || raw === "") return ""
  const value = parseFloat(String(raw).trim())
  if (!Number.isFinite(value) || value <= 0) return ""
  return value > 10 ? "10.0" : value.toFixed(1)
}
