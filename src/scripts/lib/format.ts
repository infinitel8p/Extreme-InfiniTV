import { t } from "@/scripts/lib/i18n.ts"

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

// channel identity
export function fmtChannelIdentity(
  chno: number | null | undefined,
  id: number | string,
): string {
  return typeof chno === "number" && Number.isFinite(chno)
    ? t("channel.identityNumbered", { number: chno, id })
    : t("channel.identityId", { id })
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

export function formatBehindLive(behindMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, behindMs) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const paddedSeconds = String(seconds).padStart(2, "0")
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`
  }
  return `${minutes}:${paddedSeconds}`
}

export function fmtImdbRating(raw: unknown): string {
  if (raw == null || raw === "") return ""
  const value = parseFloat(String(raw).trim())
  if (!Number.isFinite(value) || value <= 0) return ""
  return value > 10 ? "10.0" : value.toFixed(1)
}

const WIN_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
])

export function sanitizeFilename(name: unknown): string {
  let s = String(name || "download")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .replace(/^\.+/, "")
    .slice(0, 200)
    .replace(/[. ]+$/g, "")

  if (!s) return "download"

  const stem = s.split(".")[0].toUpperCase()
  if (WIN_RESERVED_NAMES.has(stem)) s = "_" + s

  return s
}
