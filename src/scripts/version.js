// scripts/version.js
import { log } from "@/scripts/lib/log.js"
import { t } from "@/scripts/lib/i18n.js"
import { getVersion, getName } from '@tauri-apps/api/app'
import { checkForUpdate } from "@/scripts/lib/update-check.js"

export async function injectVersion() {
    const badge = document.getElementById('app-version')
    if (!badge) return

    try {
        const version = await getVersion()
        const name = await getName()
        badge.textContent = `${name} v${version}`
    } catch (e) {
        log.error('Could not get app version:', e)
        const tag = document
            .querySelector('meta[name="x-app-version"]')
            ?.getAttribute('content')
        if (!tag) return
        badge.textContent = `Extreme InfiniTV v${tag}`
    }

    try {
        const status = await checkForUpdate()
        if (!status?.updateAvailable) return
        const dot = document.createElement('span')
        dot.style.cssText =
            'display:inline-block;width:6px;height:6px;margin-inline-end:0.35em;border-radius:9999px;background:var(--color-accent);vertical-align:middle'
        const suffix = document.createElement('span')
        suffix.style.color = 'var(--color-accent)'
        suffix.textContent = t('update.badgeAvailable', { version: status.latestTag })
        badge.append(' ', dot, suffix)
    } catch (e) {
        log.error('Update check failed:', e)
    }
}
