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

export function fmtElapsedMs(ms: number): string {
  if (ms < 60_000) return "just now"
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export function fmtAge(ts: number | null | undefined): string | null {
  if (!ts) return null
  return fmtElapsedMs(Date.now() - ts)
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n || n < 0) return "0 B"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function splitHms(totalSeconds: number): { hours: number; minutes: number; seconds: number } {
  const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0
  return {
    hours: Math.floor(safeSeconds / 3600),
    minutes: Math.floor((safeSeconds % 3600) / 60),
    seconds: safeSeconds % 60,
  }
}

export function formatBehindLive(behindMs: number): string {
  const { hours, minutes, seconds } = splitHms(Math.max(0, behindMs) / 1000)
  const paddedSeconds = String(seconds).padStart(2, "0")
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`
  }
  return `${minutes}:${paddedSeconds}`
}

/** Zero-padded H:MM:SS, or MM:SS under an hour. */
export function formatPaddedHms(totalSeconds: number): string {
  const { hours, minutes, seconds } = splitHms(totalSeconds)
  const paddedMinutes = String(minutes).padStart(2, "0")
  const paddedSeconds = String(seconds).padStart(2, "0")
  return hours > 0 ? `${hours}:${paddedMinutes}:${paddedSeconds}` : `${paddedMinutes}:${paddedSeconds}`
}

/** Parses a colon-delimited "HH:MM:SS" or "MM:SS" clock string into seconds. Returns 0 when unparseable. */
export function parseHmsToSeconds(value: unknown): number {
  const raw = String(value ?? "").trim()
  if (!raw.includes(":")) return 0
  const parts = raw.split(":").map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

export function fmtImdbRating(raw: unknown): string {
  if (raw == null || raw === "") return ""
  const value = parseFloat(String(raw).trim())
  if (!Number.isFinite(value) || value <= 0) return ""
  return value > 10 ? "10.0" : value.toFixed(1)
}

export function ratingSortValue(raw: unknown): number {
  if (raw == null || raw === "") return 0
  const value = parseFloat(String(raw).trim())
  if (!Number.isFinite(value) || value <= 0) return 0
  return value
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
