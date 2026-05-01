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

export function paintPoster(
    posterEl: HTMLElement | null,
    name: string,
    logo: string | null
): void {
    if (!posterEl) return
    posterEl.replaceChildren()
    if (logo) {
        const img = document.createElement("img")
        img.src = logo
        img.alt = ""
        img.loading = "eager"
        img.decoding = "async"
        img.fetchPriority = "high"
        img.referrerPolicy = "no-referrer"
        img.className = "h-full w-full object-cover"
        img.onerror = () => {
            img.remove()
            posterEl.appendChild(makePosterFallback(name))
        }
        posterEl.appendChild(img)
    } else {
        posterEl.appendChild(makePosterFallback(name))
    }
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
