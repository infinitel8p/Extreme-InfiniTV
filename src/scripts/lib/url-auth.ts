/**
 * Split embedded HTTP Basic Auth userinfo out of a URL.
 *
 * `https://user:pass@host/path` becomes `https://host/path` plus a
 * `Basic <base64>` Authorization header value, so credentials can travel in a
 * header instead of the URL (fetch rejects URLs with embedded credentials).
 */

export type SplitUrlAuthResult = { url: string; authorization: string | null }

function decodeMaybe(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

function base64Utf8(text: string): string {
    return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
}

function findAuthorityEnd(rawUrl: string, schemeEnd: number): number {
    const terminatorMatch = /[/?#]/.exec(rawUrl.slice(schemeEnd))
    return terminatorMatch ? schemeEnd + terminatorMatch.index : rawUrl.length
}

// Distinguishes a genuinely broken `host:port` (the URL is invalid for a
// reason unrelated to userinfo) from a `user:pass` pair that merely contains
// a raw `/`, `?`, or `#` needing the rescue below
function looksLikeBrokenHostPort(authority: string): boolean {
    const colonIndex = authority.indexOf(":")
    if (colonIndex === -1) return false
    const hostCandidate = authority.slice(0, colonIndex)
    const portCandidate = authority.slice(colonIndex + 1)
    if (portCandidate === "") return false
    const isNumericPort = /^\d+$/.test(portCandidate)
    if (isNumericPort && Number(portCandidate) <= 65535) return false
    return isNumericPort || hostCandidate.includes(".")
}

// Raw `/`, `?`, or `#` inside userinfo makes `new URL()` throw because the
// parser cannot tell where the authority ends. Percent-encode the segment
// before the last `@` and retry.
function rescueCredentialedUrl(rawUrl: string): URL | null {
    const schemeMatch = /^https?:\/\//i.exec(rawUrl)
    if (!schemeMatch) return null
    const lastAtIndex = rawUrl.lastIndexOf("@")
    if (lastAtIndex === -1) return null
    const schemeEnd = schemeMatch[0].length
    const authorityEnd = findAuthorityEnd(rawUrl, schemeEnd)
    if (looksLikeBrokenHostPort(rawUrl.slice(schemeEnd, authorityEnd))) return null
    const userinfo = rawUrl.slice(schemeEnd, lastAtIndex)
    const rest = rawUrl.slice(lastAtIndex + 1)
    const colonIndex = userinfo.indexOf(":")
    const encodedUser = encodeURIComponent(
        colonIndex === -1 ? userinfo : userinfo.slice(0, colonIndex),
    )
    const encodedPass =
        colonIndex === -1
            ? ""
            : `:${encodeURIComponent(userinfo.slice(colonIndex + 1))}`
    try {
        return new URL(`${rawUrl.slice(0, schemeEnd)}${encodedUser}${encodedPass}@${rest}`)
    } catch {
        return null
    }
}

export function splitUrlAuth(rawUrl: string): SplitUrlAuthResult {
    let parsed: URL
    try {
        parsed = new URL(rawUrl)
    } catch {
        const rescued = rescueCredentialedUrl(rawUrl)
        if (!rescued) return { url: rawUrl, authorization: null }
        parsed = rescued
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { url: rawUrl, authorization: null }
    }
    if (!parsed.username && !parsed.password) {
        return { url: rawUrl, authorization: null }
    }
    const username = decodeMaybe(parsed.username)
    const password = decodeMaybe(parsed.password)
    parsed.username = ""
    parsed.password = ""
    return {
        url: parsed.href,
        authorization: `Basic ${base64Utf8(`${username}:${password}`)}`,
    }
}
