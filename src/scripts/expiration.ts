import { loadCreds, getActiveEntry } from "./lib/creds.js"
import { ensureUserInfo, getExpirationMsSync } from "./lib/account-info.js"
import { t, initI18n } from "./lib/i18n.js"

const BANNER_THRESHOLD_DAYS = 7

function fmtDaysLeft(days: number): string {
    if (days <= 0) return t("expiration.expired")
    if (days === 1) return t("expiration.daysOne")
    return t("expiration.daysOther", { n: days })
}

interface RenderOpts {
    empty?: string
    emptyRaw?: string
    expDateMs?: number | null
}

function renderTargets(
    targets: NodeListOf<HTMLElement>,
    value: string | null,
    { empty = "", emptyRaw = "-", expDateMs = null }: RenderOpts = {}
): void {
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
            el.textContent = isExpired ? t("expiration.expired") : fmtDaysLeft(daysLeft)
            el.setAttribute(
                "data-state",
                isExpired ? "expired" : daysLeft <= 2 ? "critical" : "warning"
            )
            continue
        }
        if (value == null) {
            el.textContent = mode === "raw" ? emptyRaw : empty
        } else {
            el.textContent = mode === "raw" ? value : t("settings.about.expiresOn", { date: value })
        }
    }
}

export async function injectExpirationDate(): Promise<void> {
    const targets = document.querySelectorAll<HTMLElement>("[data-account-expiration]")
    if (!targets.length) return

    await initI18n()
    const creds = await loadCreds()
    const active = await getActiveEntry()
    if (!active || !creds.host || !creds.user || !creds.pass) {
        renderTargets(targets, null)
        return
    }

    await ensureUserInfo(creds, active._id)
    const expDateMs = getExpirationMsSync(active._id)
    if (expDateMs == null) {
        renderTargets(targets, null)
        return
    }
    const formatted = new Date(expDateMs).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    })
    renderTargets(targets, formatted, { expDateMs })
}
