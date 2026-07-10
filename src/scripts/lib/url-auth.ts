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

// Raw `/`, `?`, or `#` inside userinfo makes `new URL()` throw because the
// parser cannot tell where the authority ends. Percent-encode the segment
// before the last `@` and retry; the original string was invalid anyway, so
// this cannot break a previously-working URL.
function rescueCredentialedUrl(rawUrl: string): URL | null {
    const schemeMatch = /^https?:\/\//i.exec(rawUrl)
    if (!schemeMatch) return null
    const lastAtIndex = rawUrl.lastIndexOf("@")
    if (lastAtIndex === -1) return null
    const schemeEnd = schemeMatch[0].length
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
