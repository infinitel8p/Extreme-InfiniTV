// Platform-independent update check against GitHub releases. Works anywhere
// fetch works (web, Android, macOS, MS Store), unlike the Tauri auto-updater
// which only applies on Windows NSIS / Linux AppImage.

import { compareVersions } from "@/scripts/lib/version-compare.js"
import { log } from "@/scripts/lib/log.js"
import { getUpdateChannel, UPDATE_CHANNEL_EVENT } from "@/scripts/lib/app-settings.js"

export const GITHUB_RELEASES_URL =
  "https://github.com/infinitel8p/Extreme-InfiniTV/releases"
export const MS_STORE_UPDATES_URL = "ms-windows-store://downloadsandupdates"
export const STABLE_UPDATE_FEED_URL =
  "https://github.com/infinitel8p/Extreme-InfiniTV/releases/latest/download/latest.json"

const REPO_SLUG = "infinitel8p/Extreme-InfiniTV"
const PLAY_STORE_PACKAGE = "com.android.vending"

interface AndroidDeviceInfoBridge {
  getInstallSource?: () => string
  getPackageName?: () => string
}

function getAndroidDeviceInfoBridge(): AndroidDeviceInfoBridge | undefined {
  return typeof window !== "undefined"
    ? ((window as any).AndroidDeviceInfo as AndroidDeviceInfoBridge | undefined)
    : undefined
}

export function isPlayStoreInstall(): boolean {
  try {
    return getAndroidDeviceInfoBridge()?.getInstallSource?.() === PLAY_STORE_PACKAGE
  } catch {
    return false
  }
}

export function getPlayStoreUrl(): string {
  try {
    const packageName = getAndroidDeviceInfoBridge()?.getPackageName?.()
    if (packageName) return `https://play.google.com/store/apps/details?id=${packageName}`
  } catch {}
  return GITHUB_RELEASES_URL
}

export interface UpdateStatus {
  current: string
  latest: string
  latestTag: string
  latestUrl: string
  publishedAt?: string
  notes?: string
  updateAvailable: boolean
}

let lastStatus: UpdateStatus | null = null
let updateCheckPromise: Promise<UpdateStatus | null> | null = null

if (typeof document !== "undefined") {
  document.addEventListener(UPDATE_CHANNEL_EVENT, () => {
    lastStatus = null
    updateCheckPromise = null
  })
}

export async function getCurrentAppVersion(): Promise<string | null> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    return await getVersion()
  } catch {
    const meta = document
      .querySelector('meta[name="x-app-version"]')
      ?.getAttribute("content")
    return meta || null
  }
}

async function performCheck(): Promise<UpdateStatus | null> {
  try {
    const current = await getCurrentAppVersion()
    if (!current) return null

    const { fetchReleases } = await import("@/scripts/lib/changelog.js")
    const channel = getUpdateChannel()
    const allReleases = await fetchReleases()
    const eligibleReleases =
      channel === "beta"
        ? allReleases
        : allReleases.filter((release) => !release.prerelease)
    if (!eligibleReleases.length) return null

    let newestRelease = eligibleReleases[0]
    for (const release of eligibleReleases) {
      if (compareVersions(release.tagName, newestRelease.tagName) > 0) {
        newestRelease = release
      }
    }

    const latest = newestRelease.tagName.replace(/^v/i, "")
    const status: UpdateStatus = {
      current,
      latest,
      latestTag: newestRelease.tagName,
      latestUrl: newestRelease.htmlUrl || GITHUB_RELEASES_URL,
      publishedAt: newestRelease.publishedAt,
      notes: newestRelease.body,
      updateAvailable: compareVersions(latest, current) > 0,
    }

    lastStatus = status
    return status
  } catch (error) {
    log.warn("[xt:update-check] check failed:", error)
    return null
  }
}

// Memoizes a resolved status; a failed check (null) is not memoized, so the next call retries.
export async function checkForUpdate(): Promise<UpdateStatus | null> {
  if (updateCheckPromise) return updateCheckPromise
  updateCheckPromise = performCheck().then((status) => {
    if (!status) updateCheckPromise = null
    return status
  })
  return updateCheckPromise
}

export function getUpdateStatusSync(): UpdateStatus | null {
  return lastStatus
}

// Beta channel has no static feed - the newest prerelease-or-stable tag wins,
// so beta users converge back to stable once a stable release overtakes it.
export async function resolveUpdateFeedUrl(): Promise<string> {
  if (getUpdateChannel() !== "beta") return STABLE_UPDATE_FEED_URL

  try {
    const { fetchReleases } = await import("@/scripts/lib/changelog.js")
    const releases = await fetchReleases()
    if (!releases.length) return STABLE_UPDATE_FEED_URL

    let newestRelease = releases[0]
    for (const release of releases) {
      if (compareVersions(release.tagName, newestRelease.tagName) > 0) {
        newestRelease = release
      }
    }
    return `https://github.com/${REPO_SLUG}/releases/download/${newestRelease.tagName}/latest.json`
  } catch (error) {
    log.warn("[xt:update-check] beta feed resolution failed:", error)
    return STABLE_UPDATE_FEED_URL
  }
}

let storeBuildCache: boolean | null = null

export async function isStoreBuild(): Promise<boolean> {
  if (storeBuildCache != null) return storeBuildCache

  const isTauri =
    typeof window !== "undefined" &&
    (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)
  const isWindows =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent || "")
  if (!isTauri || !isWindows) {
    storeBuildCache = false
    return storeBuildCache
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    storeBuildCache = await invoke<boolean>("is_store_build")
  } catch (error) {
    log.warn("[xt:update-check] is_store_build failed:", error)
    storeBuildCache = false
  }
  return storeBuildCache
}
