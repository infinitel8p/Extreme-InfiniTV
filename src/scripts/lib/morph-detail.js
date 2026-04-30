function setAmbient(ambientEl, url) {
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

export function clearAmbient(ambientEl) {
    setAmbient(ambientEl, null)
}
