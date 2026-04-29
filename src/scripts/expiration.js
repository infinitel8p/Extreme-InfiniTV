import {
    loadCreds,
    getActiveEntry,
    buildApiUrl,
    safeHttpUrl,
} from "./lib/creds.js"
import { cachedFetch } from "./lib/cache.js"
import { providerFetch } from "./lib/provider-fetch.js"

const USER_INFO_TTL_MS = 60 * 60 * 1000 // 1 hour

const BANNER_THRESHOLD_DAYS = 7

function fmtDaysLeft(days) {
    if (days <= 0) return "Account expired"
    if (days === 1) return "Expires in 1 day"
    return `Expires in ${days} days`
}

function renderTargets(targets, value, { empty = "", emptyRaw = "-", expDateMs = null } = {}) {
    // "Expired" only when the timestamp has actually passed. The day-left
    // count is rounded UP so a 12h-remaining account reads "Expires in 1 day"
    // and stays in the warning band, not "Account expired".
    const msLeft = expDateMs == null ? null : expDateMs - Date.now()
    const isExpired = msLeft != null && msLeft <= 0
    const daysLeft = msLeft == null ? null : Math.max(0, Math.ceil(msLeft / 86_400_000))
    for (const el of targets) {
        const mode = el.getAttribute("data-account-expiration")
        if (mode === "banner") {
            if (
                daysLeft == null ||
                (!isExpired && daysLeft > BANNER_THRESHOLD_DAYS)
            ) {
                el.hidden = true
                el.textContent = ""
                el.removeAttribute("data-state")
                continue
            }
            el.hidden = false
            el.textContent = isExpired ? "Account expired" : fmtDaysLeft(daysLeft)
            el.setAttribute(
                "data-state",
                isExpired ? "expired" : daysLeft <= 2 ? "critical" : "warning"
            )
            continue
        }
        if (value == null) {
            el.textContent = mode === "raw" ? emptyRaw : empty
        } else {
            el.textContent = mode === "raw" ? value : `Account expires: ${value}`
        }
    }
}

export async function injectExpirationDate() {
    const targets = document.querySelectorAll("[data-account-expiration]")
    if (!targets.length) return

    const creds = await loadCreds()
    const active = await getActiveEntry()
    if (!active || !creds.host || !creds.user || !creds.pass) {
        renderTargets(targets, null)
        return
    }

    const apiUrl = buildApiUrl(creds, "")
    if (!safeHttpUrl(apiUrl)) {
        renderTargets(targets, null)
        return
    }

    try {
        const { data } = await cachedFetch(
            active._id,
            "user_info",
            USER_INFO_TTL_MS,
            async () => {
                const response = await providerFetch(apiUrl)
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
            renderTargets(targets, null)
            return
        }
        const expDateMs = ts * 1000
        const formatted = new Date(expDateMs).toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        })
        renderTargets(targets, formatted, { expDateMs })
    } catch (e) {
        console.error("Could not get Xtream account info:", e)
        renderTargets(targets, null)
    }
}
