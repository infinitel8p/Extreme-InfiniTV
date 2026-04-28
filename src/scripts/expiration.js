import {
    loadCreds,
    getActiveEntry,
    buildApiUrl,
    safeHttpUrl,
} from "./lib/creds.js"
import { cachedFetch } from "./lib/cache.js"

const USER_INFO_TTL_MS = 60 * 60 * 1000 // 1 hour

export async function injectExpirationDate() {
    const el = document.getElementById("account-expiration")
    if (!el) return

    const creds = await loadCreds()
    const active = await getActiveEntry()
    if (!active || !creds.host || !creds.user || !creds.pass) {
        el.textContent = ""
        return
    }

    const apiUrl = buildApiUrl(creds, "")
    if (!safeHttpUrl(apiUrl)) {
        el.textContent = ""
        return
    }

    try {
        const { data } = await cachedFetch(
            active._id,
            "user_info",
            USER_INFO_TTL_MS,
            async () => {
                const response = await fetch(apiUrl)
                if (!response.ok) {
                    throw new Error(
                        `HTTP ${response.status} ${response.statusText}`
                    )
                }
                return response.json()
            }
        )
        const ts = parseInt(data?.user_info?.exp_date ?? "", 10)
        if (!Number.isFinite(ts)) {
            el.textContent = ""
            return
        }
        const formatted = new Date(ts * 1000).toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        })
        el.textContent = `Account expires: ${formatted}`
    } catch (e) {
        console.error("Could not get Xtream account info:", e)
        el.textContent = ""
    }
}
