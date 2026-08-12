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
let updateChannelToken = 0

// reqwest transport failures reach JS as opaque strings; anything else
// (target missing from latest.json, no APPIMAGE, bad signature) is permanent.
const TRANSIENT_UPDATER_ERROR =
  /error sending request|error decoding response|timed? ?out|connection (reset|closed|refused|aborted)|dns error|network|failed to fetch/i

export function isTransientUpdaterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return TRANSIENT_UPDATER_ERROR.test(message)
}

const UPDATER_RETRY_TRIES = 3
const UPDATER_RETRY_BASE_MS = 700

export async function withUpdaterRetry<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= UPDATER_RETRY_TRIES; attempt++) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      if (attempt === UPDATER_RETRY_TRIES || !isTransientUpdaterError(error)) throw error
      log.warn(`[xt:update-check] transient failure ${attempt}/${UPDATER_RETRY_TRIES}, retrying:`, error)
      await new Promise((resolve) => setTimeout(resolve, UPDATER_RETRY_BASE_MS * attempt))
    }
  }
  throw lastError
}

if (typeof document !== "undefined") {
  document.addEventListener(UPDATE_CHANNEL_EVENT, () => {
    updateChannelToken++
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
  const tokenAtStart = updateChannelToken
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

    // Channel switched while this check was in flight; the new channel already started its own check.
    if (updateChannelToken !== tokenAtStart) return null

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
