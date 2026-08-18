import { t } from "@/scripts/lib/i18n.js"

export function setAmbient(ambientEl: HTMLElement | null, url: string | null): void {
    if (!ambientEl) return
    if (url) {
        const safe = String(url).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        ambientEl.style.backgroundImage = `url("${safe}")`
        ambientEl.setAttribute("data-ready", "true")
    } else {
        ambientEl.removeAttribute("data-ready")
        ambientEl.style.backgroundImage = ""
    }
}

export function clearAmbient(ambientEl: HTMLElement | null): void {
    setAmbient(ambientEl, null)
}

export function makePosterFallback(name: string): HTMLDivElement {
    const fb = document.createElement("div")
    fb.className =
        "h-full w-full flex items-center justify-center text-center px-3 " +
        "text-fg-3 text-xs tracking-wide bg-gradient-to-br from-surface-2 to-surface-3"
    fb.textContent = name || t("common.noPoster")
    return fb
}

function escapeUrlForCss(url: string): string {
    return url.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

const TMDB_SIZE_SEGMENT = "/t/p/"
// Portrait-render TMDb size prefixes: reject these when found right after "/t/p/".
const TMDB_PORTRAIT_SIZE_PREFIXES = ["w92/", "w154/", "w185/", "w342/", "w500/", "w600_and_h900"]

// Rejects backdrop paths that are missing, a poster duplicate, or a portrait poster mislabeled as a backdrop.
export function sanitizeProviderBackdropUrl(
    rawBackdropPath: unknown,
    posterUrl: string | null | undefined
): string | null {
    const candidate = Array.isArray(rawBackdropPath) ? rawBackdropPath[0] : rawBackdropPath
    if (typeof candidate !== "string") return null
    const url = candidate.trim()
    if (!url) return null
    if (posterUrl && url === posterUrl) return null

    const segmentIndex = url.indexOf(TMDB_SIZE_SEGMENT)
    if (segmentIndex !== -1) {
        const afterSegment = url.slice(segmentIndex + TMDB_SIZE_SEGMENT.length)
        if (TMDB_PORTRAIT_SIZE_PREFIXES.some((prefix) => afterSegment.startsWith(prefix))) return null
    }

    return url
}

// Backdrops are shot for a wide frame and render cropped-to-cover; a bare poster
// isn't, so it renders contain-and-centered over a blurred, scaled copy of itself.
export function paintHero(
    heroEl: HTMLElement | null,
    options: { name: string; posterUrl?: string | null; backdropUrls?: Array<string | null | undefined> }
): void {
    if (!heroEl) return
    const name = options.name || ""
    const posterUrl = options.posterUrl || null
    const candidates = (options.backdropUrls || []).filter(
        (url): url is string => !!url && /^https?:\/\//i.test(url)
    )
    if (candidates.length) paintHeroBackdrop(heroEl, name, candidates, 0, posterUrl)
    else paintHeroPoster(heroEl, name, posterUrl)
}

function paintHeroBackdrop(
    heroEl: HTMLElement,
    name: string,
    candidates: string[],
    index: number,
    posterUrl: string | null
): void {
    const url = candidates[index]
    if (!url) {
        paintHeroPoster(heroEl, name, posterUrl)
        return
    }
    const existing = heroEl.querySelector('img[data-hero-role="backdrop"]')
    const img = existing instanceof HTMLImageElement ? existing : document.createElement("img")
    if (!(existing instanceof HTMLImageElement)) {
        img.dataset.heroRole = "backdrop"
        img.alt = ""
        img.loading = "eager"
        img.decoding = "async"
        img.fetchPriority = "high"
        img.referrerPolicy = "no-referrer"
        img.className = "h-full w-full object-cover"
    }
    img.onerror = () => {
        paintHeroBackdrop(heroEl, name, candidates, index + 1, posterUrl)
    }
    img.src = url
    if (!(existing instanceof HTMLImageElement)) heroEl.replaceChildren(img)
}

function paintHeroPoster(heroEl: HTMLElement, name: string, posterUrl: string | null): void {
    if (!posterUrl) {
        heroEl.replaceChildren(makePosterFallback(name))
        return
    }
    const existingImg = heroEl.querySelector('img[data-hero-role="poster"]')
    const existingBlur = heroEl.querySelector("[data-hero-blur]")
    if (existingImg instanceof HTMLImageElement && existingBlur instanceof HTMLElement) {
        existingBlur.style.backgroundImage = `url("${escapeUrlForCss(posterUrl)}")`
        existingImg.onerror = () => heroEl.replaceChildren(makePosterFallback(name))
        existingImg.src = posterUrl
        return
    }
    const blurLayer = document.createElement("div")
    blurLayer.dataset.heroBlur = "true"
    blurLayer.style.backgroundImage = `url("${escapeUrlForCss(posterUrl)}")`
    const img = document.createElement("img")
    img.dataset.heroRole = "poster"
    img.alt = ""
    img.loading = "eager"
    img.decoding = "async"
    img.fetchPriority = "high"
    img.referrerPolicy = "no-referrer"
    img.className = "relative h-full w-full object-contain"
    img.src = posterUrl
    img.onerror = () => {
        heroEl.replaceChildren(makePosterFallback(name))
    }
    heroEl.replaceChildren(blurLayer, img)
}

export function chooseMime(url: string | null | undefined): string {
    if (!url) return "video/mp4"
    const lower = (url.split("?")[0] ?? "").toLowerCase()
    if (lower.endsWith(".m3u8")) return "application/x-mpegURL"
    if (lower.endsWith(".mpd")) return "application/dash+xml"
    if (lower.endsWith(".webm")) return "video/webm"
    if (lower.endsWith(".mkv")) return "video/x-matroska"
    if (lower.endsWith(".ts")) return "video/MP2T"
    if (lower.endsWith(".avi")) return "video/x-msvideo"
    return "video/mp4"
}
