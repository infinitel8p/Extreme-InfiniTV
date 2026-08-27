// TV Settings: a single scrollable row list covering playlists, display, playback, receiver and support.
import type { TvView, TvViewContext } from "@/scripts/tv/router"
import { navigate } from "astro:transitions/client"
import { t, LOCALE_EVENT, getActiveLocale, getAvailableLocales, setLocale } from "@/scripts/lib/i18n"
import { registerFocusSection, keepFocusedInView } from "@/scripts/tv/focus"
import { getEntries, getActiveEntry, isTauri } from "@/scripts/lib/creds.js"
import { renderPlaylistRow, getPlaylistListEmptyCopy } from "@/scripts/lib/playlist-rows.js"
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav"
import { confirmDialog } from "@/scripts/lib/confirm-dialog"
import {
  createSettingsList,
  openChoiceDialog,
  type SettingsRow,
  type SettingsListHandle,
  type ChoiceOption,
} from "@/scripts/tv/ui/settings-list"
import {
  getReceiverBootEnabled,
  setReceiverBootEnabled,
  getReceiverDeviceName,
  setReceiverDeviceName,
  getUpdateChannel,
  setUpdateChannel,
  getTvOverscan,
  setTvOverscan,
  TV_OVERSCAN_EVENT,
  TV_OVERSCAN_VALUES,
} from "@/scripts/lib/app-settings.js"
import { getOffsetSetting, setOffsetSetting } from "@/scripts/lib/epg-data.js"
import { checkForUpdate, isPlayStoreInstall, getPlayStoreUrl, getCurrentAppVersion } from "@/scripts/lib/update-check"
import { openExternal } from "@/scripts/lib/external-link"
import { collectDiagnosticBundle } from "@/scripts/lib/diagnostic-bundle"
import { clearAll as clearAllCache } from "@/scripts/lib/cache.js"
import { clearImageCache } from "@/scripts/lib/img-cache"
import { saveBackupSnapshot } from "@/scripts/lib/backup-snapshot"
import { toastSuccess, toastError } from "@/scripts/lib/toast"
import { log } from "@/scripts/lib/log"
import {
  ICON_X,
  ICON_LIST_DETAILS,
  ICON_WORLD,
  ICON_CLOCK_EDIT,
  ICON_ASPECT_RATIO,
  ICON_DEVICE_TV,
  ICON_USER,
  ICON_EXTERNAL_LINK,
  ICON_REFRESH,
  ICON_COPY,
  ICON_DOWNLOAD,
  ICON_TRASH,
  ICON_ALERT_TRIANGLE,
  ICON_PLAYLIST_ADD,
  ICON_PALETTE,
  ICON_TEXT_SIZE,
} from "@/scripts/lib/icons"

const SETTINGS_SECTION_ID = "tv-settings"
const KEEP_IN_VIEW_OFFSET = 120

const THEME_KEY = "xt_theme"
const FONT_SCALE_KEY = "xt_font_scale"
const FONT_SCALE_PRESETS: Array<{ value: number; labelKey: string }> = [
  { value: 0.875, labelKey: "settings.fontScale.small" },
  { value: 1, labelKey: "settings.fontScale.default" },
  { value: 1.125, labelKey: "settings.fontScale.medium" },
  { value: 1.25, labelKey: "settings.fontScale.large" },
  { value: 1.5, labelKey: "settings.fontScale.xlarge" },
]

function readTheme(): string {
  try {
    return localStorage.getItem(THEME_KEY) || "system"
  } catch {
    return "system"
  }
}

function themeLabelKey(theme: string): string {
  if (theme === "light") return "settings.theme.light"
  if (theme === "dark") return "settings.theme.dark"
  return "settings.theme.system"
}

// Mirrors settings.astro's commitTheme(), minus the view-transition sweep.
function applyTheme(theme: string): void {
  const root = document.documentElement
  if (theme === "light") root.style.colorScheme = "light"
  else if (theme === "dark") root.style.colorScheme = "dark"
  else root.style.colorScheme = ""
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {}
}

function readFontScale(): number {
  try {
    const stored = parseFloat(localStorage.getItem(FONT_SCALE_KEY) || "1")
    return Number.isFinite(stored) && stored >= 0.75 && stored <= 2 ? stored : 1
  } catch {
    return 1
  }
}

function fontScaleLabelKey(scale: number): string {
  const preset = FONT_SCALE_PRESETS.find((entry) => Math.abs(entry.value - scale) < 0.001)
  return preset?.labelKey || "settings.fontScale.default"
}

function applyFontScale(scale: number): void {
  document.documentElement.style.setProperty("--xt-font-scale", String(scale))
  try {
    if (scale === 1) localStorage.removeItem(FONT_SCALE_KEY)
    else localStorage.setItem(FONT_SCALE_KEY, String(scale))
  } catch {}
}

function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+"
  const abs = Math.abs(minutes)
  const hours = Math.floor(abs / 60)
  const remainder = abs % 60
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
}

function shareLogsAvailable(): boolean {
  return typeof window.AndroidLog?.shareNewestLog === "function"
}

const view: TvView = {
  mount(root: HTMLElement, _ctx: TvViewContext) {
    const state = {
      destroyed: false,
      playlistId: "",
      currentVersion: "",
    }

    const unsubs: Array<() => void> = []
    let list: SettingsListHandle | null = null
    let playlistsDialogEl: HTMLDialogElement | null = null
    let deviceNameDialogEl: HTMLDialogElement | null = null

    async function renderRows(): Promise<void> {
      if (state.destroyed || !list) return
      const activeEntry = await getActiveEntry()
      if (state.destroyed || !list) return
      state.playlistId = activeEntry?._id || ""

      const rows: SettingsRow[] = []

      rows.push({
        id: "playlists",
        icon: ICON_LIST_DETAILS,
        label: t("tv.settings.playlists"),
        value: activeEntry?.title || t("list.noPlaylistSelected"),
        kind: "action",
        onActivate: () => void openPlaylistsDialog(),
      })

      rows.push({
        id: "theme",
        icon: ICON_PALETTE,
        label: t("settings.theme.label"),
        value: t(themeLabelKey(readTheme())),
        kind: "choice",
        onActivate: () => void pickTheme(),
      })

      rows.push({
        id: "text-size",
        icon: ICON_TEXT_SIZE,
        label: t("tv.settings.textSize"),
        value: t(fontScaleLabelKey(readFontScale())),
        kind: "choice",
        onActivate: () => void pickTextSize(),
      })

      rows.push({
        id: "language",
        icon: ICON_WORLD,
        label: t("settings.language.label"),
        value: languageValueLabel(),
        kind: "choice",
        onActivate: () => void pickLanguage(),
      })

      rows.push({
        id: "epg-offset",
        icon: ICON_CLOCK_EDIT,
        label: t("settings.epgTimezone.title"),
        value: epgOffsetValueLabel(),
        kind: "choice",
        disabled: !state.playlistId,
        onActivate: () => void pickEpgOffset(),
      })

      const overscan = getTvOverscan()
      rows.push({
        id: "overscan",
        icon: ICON_ASPECT_RATIO,
        label: t("settings.tvOverscan.title"),
        value: overscan > 0 ? `${overscan}%` : t("settings.tvOverscan.off"),
        kind: "choice",
        onActivate: () => void pickOverscan(),
      })

      if (isTauri) {
        rows.push({
          id: "receiver-boot",
          icon: ICON_DEVICE_TV,
          label: t("settings.receiver.boot.title"),
          kind: "toggle",
          checked: getReceiverBootEnabled(),
          onActivate: () => {
            setReceiverBootEnabled(!getReceiverBootEnabled())
            void renderRows()
          },
        })

        rows.push({
          id: "device-name",
          icon: ICON_USER,
          label: t("settings.receiver.deviceName"),
          value: getReceiverDeviceName() || t("settings.receiver.deviceNamePlaceholder"),
          kind: "action",
          onActivate: () => openDeviceNameDialog(),
        })

        rows.push({
          id: "open-receiver",
          icon: ICON_EXTERNAL_LINK,
          label: t("settings.receiver.openScreen"),
          kind: "action",
          onActivate: () => {
            location.href = "/receiver"
          },
        })
      }

      rows.push({
        id: "updates",
        icon: ICON_REFRESH,
        label: t("settings.about.checkUpdate"),
        value: state.currentVersion ? `v${state.currentVersion}` : "",
        kind: "action",
        onActivate: () => void runUpdateCheck(),
      })

      const updateChannel = getUpdateChannel()
      rows.push({
        id: "update-channel",
        label: t("settings.update.channel"),
        value: t(updateChannel === "beta" ? "settings.update.channelBeta" : "settings.update.channelStable"),
        kind: "choice",
        onActivate: () => void pickUpdateChannel(),
      })

      if (shareLogsAvailable()) {
        rows.push({
          id: "share-logs",
          icon: ICON_COPY,
          label: t("settings.storage.shareLogs"),
          kind: "action",
          onActivate: () => void shareLogs(),
        })
      }

      rows.push({
        id: "export-diagnostics",
        icon: ICON_DOWNLOAD,
        label: t("settings.help.exportDiagnostics"),
        kind: "action",
        onActivate: () => void exportDiagnostics(),
      })

      rows.push({
        id: "clear-cache",
        icon: ICON_TRASH,
        label: t("settings.storage.clear"),
        kind: "action",
        onActivate: () => void clearCache(),
      })

      rows.push({
        id: "reset-everything",
        icon: ICON_ALERT_TRIANGLE,
        label: t("settings.danger.resetAll"),
        kind: "action",
        onActivate: () => void resetEverything(),
      })

      list.setRows(rows)
    }

    function languageValueLabel(): string {
      const active = getActiveLocale()
      const meta = getAvailableLocales().find((locale) => locale.code === active)
      return meta ? `${meta.nativeName} (${meta.code})` : active
    }

    async function pickTheme(): Promise<void> {
      const picked = await openChoiceDialog({
        title: t("settings.theme.label"),
        selectedId: readTheme(),
        options: [
          { id: "system", label: t("settings.theme.system") },
          { id: "light", label: t("settings.theme.light") },
          { id: "dark", label: t("settings.theme.dark") },
        ],
      })
      if (!picked) return
      applyTheme(picked)
      void renderRows()
    }

    async function pickTextSize(): Promise<void> {
      const options: ChoiceOption[] = FONT_SCALE_PRESETS.map((preset) => ({
        id: String(preset.value),
        label: t(preset.labelKey),
      }))
      const picked = await openChoiceDialog({
        title: t("tv.settings.textSize"),
        selectedId: String(readFontScale()),
        options,
      })
      if (!picked) return
      applyFontScale(parseFloat(picked))
      void renderRows()
    }

    async function pickLanguage(): Promise<void> {
      const options: ChoiceOption[] = [
        { id: "__system", label: t("settings.language.system") },
        ...getAvailableLocales().map((locale) => ({
          id: locale.code,
          label: `${locale.nativeName} (${locale.code})`,
        })),
      ]
      const picked = await openChoiceDialog({
        title: t("settings.language.label"),
        selectedId: getActiveLocale(),
        options,
      })
      if (!picked) return
      await setLocale(picked === "__system" ? null : picked)
      void renderRows()
    }

    function epgOffsetValueLabel(): string {
      if (!state.playlistId) return t("list.noPlaylistSelected")
      const setting = getOffsetSetting(state.playlistId)
      return setting === "auto" ? t("epg.timezoneAutoDetect") : formatUtcOffset(Number(setting))
    }

    async function pickEpgOffset(): Promise<void> {
      if (!state.playlistId) return
      const options: ChoiceOption[] = [{ id: "auto", label: t("epg.timezoneAutoDetect") }]
      for (let minutes = -12 * 60; minutes <= 14 * 60; minutes += 30) {
        options.push({ id: String(minutes), label: formatUtcOffset(minutes) })
      }
      const setting = getOffsetSetting(state.playlistId)
      const picked = await openChoiceDialog({
        title: t("settings.epgTimezone.title"),
        selectedId: setting === "auto" ? "auto" : String(setting),
        options,
      })
      if (picked == null) return
      setOffsetSetting(state.playlistId, picked === "auto" ? "auto" : Number(picked))
      void renderRows()
    }

    async function pickOverscan(): Promise<void> {
      const options: ChoiceOption[] = (TV_OVERSCAN_VALUES as number[]).map((value) => ({
        id: String(value),
        label: value === 0 ? t("settings.tvOverscan.off") : `${value}%`,
      }))
      const picked = await openChoiceDialog({
        title: t("settings.tvOverscan.title"),
        selectedId: String(getTvOverscan()),
        options,
      })
      if (picked == null) return
      setTvOverscan(Number(picked))
      void renderRows()
    }

    function ensureDeviceNameDialog(): HTMLDialogElement {
      if (deviceNameDialogEl) return deviceNameDialogEl
      const dialog = document.createElement("dialog")
      dialog.id = "tv-settings-device-name-dialog"
      dialog.className =
        "m-auto w-[26rem] max-w-[90vw] rounded-2xl border border-line bg-surface p-6 text-fg backdrop:bg-black/70"

      const heading = document.createElement("h2")
      heading.dataset.role = "title"
      heading.className = "text-lg font-semibold"

      const input = document.createElement("input")
      input.type = "text"
      input.dataset.role = "input"
      input.className = "field-input mt-4 w-full"

      const actions = document.createElement("div")
      actions.className = "mt-4 flex justify-end gap-2"
      const cancelButton = document.createElement("button")
      cancelButton.type = "button"
      cancelButton.dataset.role = "cancel"
      cancelButton.className = "btn"
      const saveButton = document.createElement("button")
      saveButton.type = "button"
      saveButton.dataset.role = "save"
      saveButton.className = "btn-primary"
      actions.append(cancelButton, saveButton)

      dialog.append(heading, input, actions)
      document.body.appendChild(dialog)

      cancelButton.addEventListener("click", () => dialog.close())
      saveButton.addEventListener("click", () => {
        setReceiverDeviceName(input.value.trim())
        dialog.close()
        void renderRows()
      })
      attachDialogSpatialNav(dialog, { defaultElement: `#${dialog.id} [data-role="input"]` })

      deviceNameDialogEl = dialog
      return dialog
    }

    function openDeviceNameDialog(): void {
      const dialog = ensureDeviceNameDialog()
      const heading = dialog.querySelector<HTMLElement>('[data-role="title"]')
      const input = dialog.querySelector<HTMLInputElement>('[data-role="input"]')
      const cancelButton = dialog.querySelector<HTMLElement>('[data-role="cancel"]')
      const saveButton = dialog.querySelector<HTMLElement>('[data-role="save"]')
      if (heading) heading.textContent = t("settings.receiver.deviceName")
      if (input) {
        input.value = getReceiverDeviceName()
        input.placeholder = t("settings.receiver.deviceNamePlaceholder")
      }
      if (cancelButton) cancelButton.textContent = t("common.cancel")
      if (saveButton) saveButton.textContent = t("common.save")
      if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal()
    }

    async function runUpdateCheck(): Promise<void> {
      const status = await checkForUpdate()
      if (state.destroyed) return
      if (!status) {
        toastError(t("tv.settings.updateCheckFailed"))
        return
      }
      if (!status.updateAvailable) {
        toastSuccess(t("settings.about.upToDate"))
        return
      }
      const opened = await confirmDialog({
        title: t("settings.about.updateAvailable", { version: status.latest }),
        message: status.publishedAt
          ? t("settings.update.releasedOn", { date: new Date(status.publishedAt).toLocaleDateString() })
          : t("settings.update.updateAvailableMsg"),
        confirmLabel: t("tv.settings.openDownloadPage"),
        cancelLabel: t("common.close"),
      })
      if (!opened) return
      const target = isPlayStoreInstall() ? getPlayStoreUrl() : status.latestUrl
      await openExternal(target)
    }

    async function pickUpdateChannel(): Promise<void> {
      const picked = await openChoiceDialog({
        title: t("settings.update.channel"),
        selectedId: getUpdateChannel(),
        options: [
          { id: "stable", label: t("settings.update.channelStable") },
          { id: "beta", label: t("settings.update.channelBeta") },
        ],
      })
      if (!picked) return
      setUpdateChannel(picked)
      void renderRows()
    }

    async function shareLogs(): Promise<void> {
      try {
        const { appLogDir } = await import("@tauri-apps/api/path")
        const dir = await appLogDir()
        const bridge = window.AndroidLog
        const shared = typeof bridge?.shareNewestLog === "function" ? bridge.shareNewestLog(dir) : false
        if (!shared) toastError(t("settings.storage.noLogs"))
      } catch (error) {
        log.warn("[tv:settings] share logs failed:", error)
        toastError(t("settings.storage.shareLogsFail"))
      }
    }

    async function exportDiagnostics(): Promise<void> {
      try {
        const bundle = await collectDiagnosticBundle()
        const isAndroidEnv = /Android/i.test(navigator.userAgent || "")
        let savedTo = ""
        if (isAndroidEnv) {
          const androidFs = await import("@/scripts/lib/android-fs.js")
          let pickerError: unknown = null
          try {
            const written = await androidFs.saveBinaryFile(bundle.filename, bundle.bytes, "application/zip")
            if (!written) return
            try {
              await androidFs.shareFile(written)
            } catch (shareError) {
              log.warn("[tv:settings] diagnostics share failed:", shareError)
            }
          } catch (error) {
            pickerError = error
          }
          if (pickerError) {
            try {
              savedTo = (await androidFs.savePublicBinaryFile(bundle.filename, bundle.bytes, "application/zip")) || ""
            } catch (publicError) {
              log.error("[tv:settings] diagnostics public save failed:", publicError)
              toastError(t("settings.toast.diagnosticsExportFail"))
              return
            }
          }
        } else {
          const { save } = await import("@tauri-apps/plugin-dialog")
          const target = await save({ defaultPath: bundle.filename, filters: [{ name: "ZIP", extensions: ["zip"] }] })
          if (!target) return
          const { writeFile } = await import("@tauri-apps/plugin-fs")
          await writeFile(target, bundle.bytes)
          savedTo = target
        }
        toastSuccess(t("settings.toast.diagnosticsExported"), { description: savedTo || undefined })
      } catch (error) {
        log.error("[tv:settings] export diagnostics failed:", error)
        toastError(t("settings.toast.diagnosticsExportFail"))
      }
    }

    async function clearCache(): Promise<void> {
      const confirmed = await confirmDialog({
        title: t("settings.storage.clear"),
        message: t("settings.storage.helperLong"),
        confirmLabel: t("settings.storage.clear"),
      })
      if (!confirmed) return
      try {
        await clearAllCache()
        await clearImageCache()
        toastSuccess(t("settings.toast.cacheCleared"))
      } catch (error) {
        log.error("[tv:settings] clear cache failed:", error)
        toastError(t("settings.toast.cacheClearFail"))
      }
    }

    async function resetEverything(): Promise<void> {
      const confirmed = await confirmDialog({
        title: t("settings.danger.resetAll"),
        message: t("settings.danger.resetConfirm"),
        confirmLabel: t("settings.danger.resetAll"),
        destructive: true,
      })
      if (!confirmed) return
      try {
        await saveBackupSnapshot()
      } catch (error) {
        log.warn("[tv:settings] reset backup snapshot failed:", error)
      }
      try {
        await clearAllCache()
      } catch {}
      try {
        localStorage.clear()
      } catch {}
      try {
        sessionStorage.clear()
      } catch {}
      try {
        for (const cookie of document.cookie.split(";")) {
          const eqIndex = cookie.indexOf("=")
          const name = (eqIndex > -1 ? cookie.slice(0, eqIndex) : cookie).trim()
          if (!name) continue
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
        }
      } catch {}
      try {
        const { Store } = await import("@tauri-apps/plugin-store")
        const store = await Store.load(".xtream.creds.json")
        const keys = await store.keys()
        for (const key of keys) await store.delete(key)
        await store.save()
      } catch (error) {
        log.warn("[tv:settings] reset tauri store failed:", error)
      }
      location.href = "/tv"
    }

    function ensurePlaylistsDialog(): HTMLDialogElement {
      if (playlistsDialogEl) return playlistsDialogEl
      const dialog = document.createElement("dialog")
      dialog.id = "tv-settings-playlists-dialog"
      dialog.className =
        "m-auto max-h-[70vh] w-[28rem] max-w-[90vw] rounded-2xl border border-line bg-surface p-0 text-fg backdrop:bg-black/70"

      const header = document.createElement("div")
      header.className = "flex items-center justify-between gap-4 border-b border-line px-6 py-4"
      const heading = document.createElement("h2")
      heading.dataset.role = "title"
      heading.className = "text-lg font-semibold"
      const closeButton = document.createElement("button")
      closeButton.type = "button"
      closeButton.dataset.role = "close"
      closeButton.className = "rounded-lg p-2 text-fg-3 hover:bg-surface-2 hover:text-fg"
      const closeIcon = document.createElement("span")
      closeIcon.className = "inline-flex text-base"
      closeIcon.innerHTML = ICON_X
      closeButton.appendChild(closeIcon)
      closeButton.addEventListener("click", () => dialog.close())
      header.append(heading, closeButton)

      const listEl = document.createElement("div")
      listEl.dataset.role = "list"
      listEl.className = "flex max-h-[45vh] flex-col overflow-y-auto p-[var(--tv-focus-pad)]"

      const footer = document.createElement("div")
      footer.className = "border-t border-line p-2"
      const addLink = document.createElement("a")
      addLink.href = "/tv/login"
      addLink.className =
        "flex min-h-11 items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-medium text-accent outline-none " +
        "hover:bg-surface-2 focus-visible:bg-surface-2"
      const addIcon = document.createElement("span")
      addIcon.className = "inline-flex text-base"
      addIcon.innerHTML = ICON_PLAYLIST_ADD
      const addLabel = document.createElement("span")
      addLabel.dataset.role = "add-label"
      addLink.append(addIcon, addLabel)
      footer.appendChild(addLink)

      dialog.append(header, listEl, footer)
      document.body.appendChild(dialog)
      dialog.addEventListener("close", () => void renderRows())
      attachDialogSpatialNav(dialog)

      playlistsDialogEl = dialog
      return dialog
    }

    async function openPlaylistsDialog(): Promise<void> {
      const dialog = ensurePlaylistsDialog()
      const heading = dialog.querySelector<HTMLElement>('[data-role="title"]')
      const closeButton = dialog.querySelector<HTMLElement>('[data-role="close"]')
      const addLabel = dialog.querySelector<HTMLElement>('[data-role="add-label"]')
      if (heading) heading.textContent = t("tv.playlist.switchTitle")
      if (closeButton) closeButton.setAttribute("aria-label", t("common.close"))
      if (addLabel) addLabel.textContent = t("playlist.addCta")
      const listEl = dialog.querySelector<HTMLElement>('[data-role="list"]')
      if (listEl) {
        const [entries, active] = await Promise.all([getEntries(), getActiveEntry()])
        listEl.replaceChildren()
        if (!entries.length) {
          const empty = document.createElement("p")
          empty.className = "px-4 py-4 text-xs text-fg-3"
          empty.textContent = getPlaylistListEmptyCopy()
          listEl.appendChild(empty)
        }
        for (const entry of entries) {
          listEl.appendChild(
            renderPlaylistRow({
              entry,
              isActive: active?._id === entry._id,
              density: "compact",
              onAfterSelect: async () => {
                dialog.close()
                try {
                  await navigate(location.href, { history: "replace" })
                } catch {
                  location.reload()
                }
              },
              onAfterRemove: () => void openPlaylistsDialog(),
            })
          )
        }
      }
      if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal()
    }

    function onRefreshEvent(): void {
      void renderRows()
    }

    async function loadVersion(): Promise<void> {
      const version = await getCurrentAppVersion()
      if (state.destroyed) return
      state.currentVersion = version || ""
      void renderRows()
    }

    function buildShell(): void {
      root.replaceChildren()

      const heading = document.createElement("h1")
      heading.className = "text-2xl font-semibold text-fg"
      heading.textContent = t("nav.settings")

      const scroller = document.createElement("div")
      scroller.id = SETTINGS_SECTION_ID
      // overflow-hidden: keepFocusedInView owns the scrolling, so no native scrollbar.
      scroller.className = "mt-6 min-h-0 flex-1 overflow-hidden p-[var(--tv-focus-pad)] -mx-[var(--tv-focus-pad)]"

      list = createSettingsList({ focusSectionId: "tv-settings-rows" })
      scroller.appendChild(list.el)

      const wrap = document.createElement("div")
      wrap.className = "flex h-full flex-col"
      wrap.append(heading, scroller)
      root.appendChild(wrap)

      unsubs.push(registerFocusSection(SETTINGS_SECTION_ID, scroller, { enterTo: "last-focused" }))
      unsubs.push(keepFocusedInView(scroller, "y", KEEP_IN_VIEW_OFFSET))

      document.addEventListener(LOCALE_EVENT, onRefreshEvent)
      document.addEventListener("xt:active-changed", onRefreshEvent)
      document.addEventListener("xt:entries-updated", onRefreshEvent)
      document.addEventListener(TV_OVERSCAN_EVENT, onRefreshEvent)
    }

    async function boot(): Promise<void> {
      buildShell()
      await renderRows()
      if (state.destroyed || !list) return
      list.el.querySelector<HTMLElement>("[data-focus-key]")?.focus()
      void loadVersion()
    }

    void boot()

    return () => {
      state.destroyed = true
      document.removeEventListener(LOCALE_EVENT, onRefreshEvent)
      document.removeEventListener("xt:active-changed", onRefreshEvent)
      document.removeEventListener("xt:entries-updated", onRefreshEvent)
      document.removeEventListener(TV_OVERSCAN_EVENT, onRefreshEvent)
      for (const unsub of unsubs) unsub()
      list?.destroy()
      playlistsDialogEl?.remove()
      deviceNameDialogEl?.remove()
      root.replaceChildren()
    }
  },
}

export default view
