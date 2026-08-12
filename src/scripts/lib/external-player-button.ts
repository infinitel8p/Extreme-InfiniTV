// Shared escape-hatch button covering both platform handoff paths:
//   Desktop:  "Open in MPV/VLC" - spawns the configured external player
//             via launch_external_player Tauri command. Hidden when no
//             path is configured or when the backend is already external.
//   Android:  "Open in player…" - fires Intent.ACTION_VIEW via the
//             AndroidIntent bridge, wrapped in createChooser() so the
//             user picks every time
//
// The button stays hidden on web (no Tauri bridge available). Each call
// site supplies a getter for the current source URL plus optional
// headers / title / "before launch" hooks.

import { log } from "@/scripts/lib/log.js"
import {
  getPlayerBackend,
  getPlayerPath,
  getExternalPlayerPref,
  PLAYER_BACKEND_EVENT,
  EXTERNAL_PLAYER_BACKENDS,
  getRememberedAndroidPlayer,
  setRememberedAndroidPlayer,
  clearRememberedAndroidPlayer,
} from "@/scripts/lib/app-settings.js"
import {
  getExternalLauncher,
  externalPlayersAvailable,
  androidExternalAvailable,
  getAndroidHandoffLauncher,
  listAndroidVideoPlayerApps,
  openStreamInAndroidPackage,
  androidMimeForUrl,
  AndroidHandoffError,
  PlayerLaunchError,
  PlayerNotConfiguredError,
  type AndroidHandoffKind,
  type ExternalPlayerKind,
  type ExternalLaunchOptions,
} from "@/scripts/lib/player-runtime.ts"
import { openAndroidPlayerPicker } from "@/scripts/lib/player-picker-dialog.ts"
import { pickExternalPlayer } from "@/scripts/lib/external-player-choice-dialog.ts"
import { toast, toastError } from "@/scripts/lib/toast.js"
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"

type ButtonKind = ExternalPlayerKind | AndroidHandoffKind

export interface EscapeHatchHooks {
  getSrc(): string | null | undefined
  getHeaders?(): { userAgent?: string | null; referer?: string | null } | null | undefined
  getResumeSeconds?(): number
  getTitle?(): string | null | undefined
  beforeLaunch?(kind: ButtonKind): void
  afterLaunch?(kind: ButtonKind): void
}

function configuredExternalKinds(): ExternalPlayerKind[] {
  return (EXTERNAL_PLAYER_BACKENDS as ExternalPlayerKind[]).filter((kind) => getPlayerPath(kind))
}

function pickPreferredExternal(): ExternalPlayerKind | null {
  const pref = getExternalPlayerPref()
  if ((pref === "mpv" || pref === "vlc") && getPlayerPath(pref)) return pref
  return configuredExternalKinds()[0] || null
}

function pickPreferredAndroidHandoff(): AndroidHandoffKind {
  return "system"
}

export function hasAvailableExternalPlayer(): boolean {
  if (androidExternalAvailable) return true
  if (!externalPlayersAvailable) return false
  const backend = getPlayerBackend()
  if (backend === "mpv" || backend === "vlc") return false
  return pickPreferredExternal() !== null
}

function labelFor(kind: ButtonKind): string {
  if (kind === "system") {
    const localized = t("settings.playback.openInSystem")
    if (localized && localized !== "settings.playback.openInSystem") return localized
    return "Open in player…"
  }
  const playerName = kind === "vlc" ? "VLC" : kind.toUpperCase()
  const localized = t("settings.playback.openIn", { player: playerName })
  if (localized && localized !== "settings.playback.openIn") return localized
  return `Open in ${playerName}`
}

function isAndroidKind(kind: ButtonKind): kind is AndroidHandoffKind {
  return kind === "system" || (kind === "vlc" && androidExternalAvailable)
}

export interface ExternalPlayerButtonHandle {
  refresh(): void
  dispose(): void
}

/**
 * Wire an escape-hatch button on a player surface. Returns a handle so the
 * caller can refresh visibility when source readiness changes.
 */
export function setupExternalPlayerButton(
  btn: HTMLButtonElement | null,
  hooks: EscapeHatchHooks,
): ExternalPlayerButtonHandle {
  if (!btn) return { refresh: () => {}, dispose: () => {} }

  const labelEl = btn.querySelector<HTMLElement>("[data-label]") || btn

  const refresh = () => {
    if (!hooks.getSrc()) {
      btn.hidden = true
      return
    }
    if (androidExternalAvailable) {
      const kind = pickPreferredAndroidHandoff()
      btn.hidden = false
      btn.dataset.kind = kind
      btn.dataset.platform = "android"
      labelEl.textContent = labelFor(kind)
      return
    }
    if (!externalPlayersAvailable) {
      btn.hidden = true
      return
    }
    const backend = getPlayerBackend()
    if (backend === "mpv" || backend === "vlc") {
      btn.hidden = true
      return
    }
    const preferred = pickPreferredExternal()
    if (!preferred) {
      btn.hidden = true
      return
    }
    btn.hidden = false
    btn.dataset.kind = preferred
    btn.dataset.platform = "desktop"
    const configured = configuredExternalKinds()
    labelEl.textContent =
      getExternalPlayerPref() === "ask" && configured.length > 1
        ? labelFor("system")
        : labelFor(preferred)
  }

  const onClick = async () => {
    const src = hooks.getSrc()
    if (!src) {
      toastError(t("settings.playback.noSource") || "Nothing to play yet.")
      return
    }
    const isAndroid = btn.dataset.platform === "android"
    const kind = (btn.dataset.kind as ButtonKind) ||
      (isAndroid ? pickPreferredAndroidHandoff() : pickPreferredExternal())
    if (!kind) return
    const notifyLaunched = (launchedKind: ButtonKind) => {
      try {
        hooks.afterLaunch?.(launchedKind)
      } catch (err) {
        log.warn("[xt:external-btn] afterLaunch threw:", err)
      }
    }
    try {
      hooks.beforeLaunch?.(kind)
    } catch (err) {
      log.warn("[xt:external-btn] beforeLaunch threw:", err)
    }
    const headers = hooks.getHeaders?.() || null
    const title = hooks.getTitle?.() || null
    if (isAndroid && isAndroidKind(kind)) {
      if (kind === "vlc") {
        const launcher = getAndroidHandoffLauncher("vlc")
        toast({
          title: t("settings.playback.launching", { player: "VLC" }) || "Launching VLC…",
          duration: 2000,
        })
        try {
          await launcher.launch(src, {
            userAgent: headers?.userAgent ?? null,
            referer: headers?.referer ?? null,
            title,
          })
          notifyLaunched(kind)
        } catch (err) {
          surfaceAndroidHandoffError(err, kind)
        }
        return
      }
      // "system" path: enumerate handlers, show our own picker, launch
      // via setPackage(). See player-picker-dialog.ts for the rationale -
      // chooser-routed intents fail on VLC because Android picks the wrong
      // VLC activity for the resolved intent.
      const mime = androidMimeForUrl(src)
      const apps = listAndroidVideoPlayerApps(src, mime)
      if (apps.length === 0) {
        toastError(
          t("settings.playback.androidNoHandler") ||
            "No app on this device can play this stream. Install VLC or MX Player.",
        )
        return
      }
      // If the user previously ticked "Always use this app" and that app is
      // still installed, skip the picker and launch directly
      const remembered = getRememberedAndroidPlayer()
      if (remembered) {
        const stillInstalled = apps.find((app) => app.pkg === remembered.pkg)
        if (stillInstalled) {
          toast({
            title:
              t("settings.playback.launching", {
                player: stillInstalled.label || stillInstalled.pkg,
              }) || `Launching ${stillInstalled.label || stillInstalled.pkg}…`,
            duration: 2000,
          })
          try {
            await openStreamInAndroidPackage(stillInstalled.pkg, src, {
              activity: stillInstalled.activity || remembered.activity || null,
              userAgent: headers?.userAgent ?? null,
              referer: headers?.referer ?? null,
              title,
              mime,
            })
            notifyLaunched("system")
          } catch (err) {
            surfaceAndroidHandoffError(err, "system")
          }
          return
        }
        clearRememberedAndroidPlayer()
      }
      const choice = await openAndroidPlayerPicker({
        apps,
        contentTitle: title,
      })
      if (!choice) return
      const { app: pickedApp, remember } = choice
      if (remember) {
        setRememberedAndroidPlayer({
          pkg: pickedApp.pkg,
          activity: pickedApp.activity,
          label: pickedApp.label || pickedApp.pkg,
          icon: pickedApp.icon,
        })
      }
      toast({
        title:
          t("settings.playback.launching", { player: pickedApp.label || pickedApp.pkg }) ||
          `Launching ${pickedApp.label || pickedApp.pkg}…`,
        duration: 2000,
      })
      try {
        await openStreamInAndroidPackage(pickedApp.pkg, src, {
          activity: pickedApp.activity || null,
          userAgent: headers?.userAgent ?? null,
          referer: headers?.referer ?? null,
          title,
          mime,
        })
        notifyLaunched("system")
      } catch (err) {
        surfaceAndroidHandoffError(err, "system")
      }
      return
    }
    let desktopKind = kind as ExternalPlayerKind
    const configured = configuredExternalKinds()
    if (getExternalPlayerPref() === "ask" && configured.length > 1) {
      const chosen = await pickExternalPlayer(configured, { subtitle: title || undefined })
      if (!chosen) return
      desktopKind = chosen
    }
    const launcher = getExternalLauncher(desktopKind)
    const opts: ExternalLaunchOptions = {
      userAgent: headers?.userAgent ?? null,
      referer: headers?.referer ?? null,
      resumeSeconds: hooks.getResumeSeconds?.() ?? 0,
    }
    toast({
      title:
        t("settings.playback.launching", { player: desktopKind.toUpperCase() }) ||
        `Launching ${desktopKind.toUpperCase()}…`,
      duration: 2000,
    })
    try {
      await launcher.launch(src, opts)
      notifyLaunched(desktopKind)
    } catch (err) {
      surfaceLaunchError(err, desktopKind)
    }
  }

  btn.addEventListener("click", onClick)
  document.addEventListener(PLAYER_BACKEND_EVENT, refresh)
  document.addEventListener("xt:settings-changed", refresh as EventListener)
  document.addEventListener(LOCALE_EVENT, refresh)

  refresh()

  return {
    refresh,
    dispose() {
      btn.removeEventListener("click", onClick)
      document.removeEventListener(PLAYER_BACKEND_EVENT, refresh)
      document.removeEventListener("xt:settings-changed", refresh as EventListener)
      document.removeEventListener(LOCALE_EVENT, refresh)
    },
  }
}

export function surfaceAndroidHandoffError(err: unknown, kind: AndroidHandoffKind): void {
  if (err instanceof AndroidHandoffError) {
    if (err.code === "NO_HANDLER") {
      toastError(
        t("settings.playback.androidNoHandler") ||
          "No app on this device can play this stream. Install VLC or MX Player.",
      )
      return
    }
    if (err.code === "VLC_MISSING") {
      toastError(
        t("settings.playback.androidVlcMissing") ||
          "VLC for Android isn't installed.",
      )
      return
    }
    if (err.code === "NO_BRIDGE") {
      toastError(
        t("settings.playback.androidNoBridge") ||
          "External playback isn't available on this device.",
      )
      return
    }
  }
  log.error("[xt:external-btn] android handoff threw:", err)
  const playerName = kind === "vlc" ? "VLC" : "external player"
  toastError(`Couldn't open in ${playerName}.`)
}

export function surfaceLaunchError(err: unknown, kind: ExternalPlayerKind): void {
  const playerName = kind.toUpperCase()
  if (err instanceof PlayerNotConfiguredError) {
    log.warn(`[xt:external-btn] ${playerName} not configured`)
    toastError(
      t("settings.playback.notConfigured", { player: playerName }) ||
        `${playerName} isn't configured. Set its path in Settings → Playback.`,
    )
    return
  }
  if (err instanceof PlayerLaunchError) {
    log.warn(`[xt:external-btn] ${playerName} launch failed:`, err.message)
    const key = `settings.playback.error.${err.code.toLowerCase()}`
    const localized = t(key, { player: playerName, path: err.path })
    toastError(
      localized && localized !== key
        ? localized
        : `Couldn't launch ${playerName}: ${err.message}`,
    )
    return
  }
  log.error(`[xt:external-btn] ${playerName} launch threw:`, err)
  toastError(`Couldn't launch ${playerName}.`)
}
