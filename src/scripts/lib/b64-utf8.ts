// Decode a (possibly base64-encoded UTF-8) string. Some Xtream providers
// return EPG fields as base64 to avoid HTTP-header escaping issues; others
// return plain UTF-8. We sniff the shape and decode when it looks valid,
// returning the original string when it doesn't (or when decoded output
// is meaningless whitespace, which happens on legitimate non-base64 text
// that happens to match the charset regex).

const textDecoder = new TextDecoder("utf-8")

export function maybeB64ToUtf8(str: unknown): string {
  if (!str || typeof str !== "string") return (str as string) || ""
  const looksB64 =
    /^[A-Za-z0-9+/=\s]+$/.test(str) && str.replace(/\s+/g, "").length % 4 === 0
  if (!looksB64) return str
  try {
    const bin = atob(str.replace(/\s+/g, ""))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const utf8 = textDecoder.decode(bytes)
    return utf8.replace(/\s/g, "").length === 0 ? str : utf8
  } catch {
    return str
  }
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}
