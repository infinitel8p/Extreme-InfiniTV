// scripts/version.js
import { log } from "@/scripts/lib/log.js"
import { t } from "@/scripts/lib/i18n.js"
import { getVersion, getName } from '@tauri-apps/api/app'
import { checkForUpdate } from "@/scripts/lib/update-check.js"
import { ICON_ARROW_UP } from "@/scripts/lib/icons.js"

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
        const icon = document.createElement('span')
        icon.className = 'xt-update-blink'
        icon.style.cssText =
            'display:inline-flex;font-size:0.9em;margin-inline-end:0.35em;color:var(--color-accent);vertical-align:-0.15em'
        icon.innerHTML = ICON_ARROW_UP
        const label = document.createElement('span')
        label.style.color = 'var(--color-accent)'
        label.textContent = t('update.badgeAvailable', { version: status.latestTag })
        badge.replaceChildren(icon, label)
    } catch (e) {
        log.error('Update check failed:', e)
    }
}
