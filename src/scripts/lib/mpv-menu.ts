// Pure builder for mpv's native context menu, shown via the `mpv_embed_show_menu` Tauri command.

import { t } from "@/scripts/lib/i18n"

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export function formatPlaybackRate(rate: number): string {
  return `${rate}x`
}

/** Shape per the `mpv_embed_show_menu` contract; native ids are assigned by `buildMpvMenu`. */
export interface MenuItem {
  id?: number
  kind: "item" | "checkbox" | "radio" | "separator" | "submenu" | "title"
  title?: string
  checked?: boolean
  disabled?: boolean
  submenu?: MenuItem[]
}

export interface MpvMenuTrack {
  id: number
  label: string
  active: boolean
}

export interface MpvMenuSubtitleStyleValue {
  size: "small" | "normal" | "large" | "xlarge"
  position: "bottom" | "raised"
  color: "white" | "yellow"
}

export type MpvMenuKind =
  | "audio"
  | "subtitles"
  | "speed"
  | "subtitleDelay"
  | "audioDelay"
  | "subtitleStyle"
  | "root"

export interface MpvMenuAudioModel {
  tracks: MpvMenuTrack[]
}
export interface MpvMenuSubtitlesModel {
  tracks: MpvMenuTrack[]
}
export interface MpvMenuSpeedModel {
  currentRate: number
}
export interface MpvMenuDelayModel {
  currentSeconds: number
}
export interface MpvMenuSubtitleStyleModel {
  style: MpvMenuSubtitleStyleValue
}
export interface MpvMenuRootModel {
  audioTracks: MpvMenuTrack[]
  subtitleTracks: MpvMenuTrack[]
  currentRate: number
  subtitleDelaySeconds: number
  audioDelaySeconds: number
  subtitleStyle: MpvMenuSubtitleStyleValue
}

export type MpvMenuPick =
  | { kind: "audio"; id: number }
  | { kind: "subtitle"; id: number | null }
  | { kind: "subtitle-file" }
  | { kind: "speed"; rate: number }
  | { kind: "subtitle-delay-step"; deltaMs: number }
  | { kind: "subtitle-delay-reset" }
  | { kind: "audio-delay-step"; deltaMs: number }
  | { kind: "audio-delay-reset" }
  | { kind: "subtitle-style-size"; size: MpvMenuSubtitleStyleValue["size"] }
  | { kind: "subtitle-style-position"; position: MpvMenuSubtitleStyleValue["position"] }
  | { kind: "subtitle-style-color"; color: MpvMenuSubtitleStyleValue["color"] }
  | { kind: "subtitle-style-reset" }

export interface MpvMenuBuildResult {
  items: MenuItem[]
  picks: Map<number, MpvMenuPick>
}

type Register = (pick: MpvMenuPick) => number

const DELAY_STEPS_MS = [-500, -250, -100, 100, 250, 500]

function formatStepLabel(deltaMs: number): string {
  return `${deltaMs >= 0 ? "+" : ""}${deltaMs} ms`
}

function titleSection(title: string): MenuItem[] {
  return [{ kind: "title", title }, { kind: "separator" }]
}

function audioChoiceItems(tracks: MpvMenuTrack[], register: Register): MenuItem[] {
  return tracks.map((track) => ({
    kind: "radio",
    title: track.label,
    checked: track.active,
    id: register({ kind: "audio", id: track.id }),
  }))
}

function subtitleChoiceItems(tracks: MpvMenuTrack[], register: Register): MenuItem[] {
  const anyActive = tracks.some((track) => track.active)
  const items: MenuItem[] = [
    {
      kind: "radio",
      title: t("player.subtitles.off"),
      checked: !anyActive,
      disabled: tracks.length === 0,
      id: register({ kind: "subtitle", id: null }),
    },
    ...tracks.map((track) => ({
      kind: "radio" as const,
      title: track.label,
      checked: track.active,
      id: register({ kind: "subtitle", id: track.id }),
    })),
  ]
  items.push({ kind: "separator" })
  items.push({ kind: "item", title: t("player.subtitles.loadFile"), id: register({ kind: "subtitle-file" }) })
  return items
}

function speedChoiceItems(currentRate: number, register: Register): MenuItem[] {
  return PLAYBACK_RATES.map((rate) => ({
    kind: "radio",
    title: formatPlaybackRate(rate),
    checked: Math.abs(rate - currentRate) < 0.001,
    id: register({ kind: "speed", rate }),
  }))
}

function delayTitle(kind: "subtitle" | "audio", currentSeconds: number): string {
  const roundedMs = Math.round(currentSeconds * 1000)
  const ms = `${roundedMs >= 0 ? "+" : ""}${roundedMs}`
  if (kind === "subtitle") {
    return t("player.subtitleDelay", { value: t("player.mpv.subtitleDelay.value", { ms }) })
  }
  return t("player.mpv.audioDelay.titleWithValue", { value: t("player.mpv.audioDelay.value", { ms }) })
}

function delayChoiceItems(kind: "subtitle" | "audio", register: Register): MenuItem[] {
  const items: MenuItem[] = DELAY_STEPS_MS.map((deltaMs) => ({
    kind: "item",
    title: formatStepLabel(deltaMs),
    id: register(kind === "subtitle" ? { kind: "subtitle-delay-step", deltaMs } : { kind: "audio-delay-step", deltaMs }),
  }))
  items.push({ kind: "separator" })
  items.push({
    kind: "item",
    title: t("player.controls.reset"),
    id: register(kind === "subtitle" ? { kind: "subtitle-delay-reset" } : { kind: "audio-delay-reset" }),
  })
  return items
}

function buildDelayItems(kind: "subtitle" | "audio", currentSeconds: number, register: Register): MenuItem[] {
  return [{ kind: "title", title: delayTitle(kind, currentSeconds) }, { kind: "separator" }, ...delayChoiceItems(kind, register)]
}

const SUBTITLE_SIZE_LABEL_KEYS: Record<MpvMenuSubtitleStyleValue["size"], string> = {
  small: "player.mpv.subtitleStyle.sizeSmall",
  normal: "player.mpv.subtitleStyle.sizeNormal",
  large: "player.mpv.subtitleStyle.sizeLarge",
  xlarge: "player.mpv.subtitleStyle.sizeXLarge",
}
const SUBTITLE_POSITION_LABEL_KEYS: Record<MpvMenuSubtitleStyleValue["position"], string> = {
  bottom: "player.mpv.subtitleStyle.positionBottom",
  raised: "player.mpv.subtitleStyle.positionRaised",
}
const SUBTITLE_COLOR_LABEL_KEYS: Record<MpvMenuSubtitleStyleValue["color"], string> = {
  white: "player.mpv.subtitleStyle.colorWhite",
  yellow: "player.mpv.subtitleStyle.colorYellow",
}

function subtitleStyleChoiceItems(style: MpvMenuSubtitleStyleValue, register: Register): MenuItem[] {
  const items: MenuItem[] = [
    {
      kind: "submenu",
      title: t("player.mpv.subtitleStyle.size"),
      submenu: (Object.keys(SUBTITLE_SIZE_LABEL_KEYS) as MpvMenuSubtitleStyleValue["size"][]).map((size) => ({
        kind: "radio",
        title: t(SUBTITLE_SIZE_LABEL_KEYS[size]),
        checked: style.size === size,
        id: register({ kind: "subtitle-style-size", size }),
      })),
    },
    {
      kind: "submenu",
      title: t("player.mpv.subtitleStyle.position"),
      submenu: (Object.keys(SUBTITLE_POSITION_LABEL_KEYS) as MpvMenuSubtitleStyleValue["position"][]).map((position) => ({
        kind: "radio",
        title: t(SUBTITLE_POSITION_LABEL_KEYS[position]),
        checked: style.position === position,
        id: register({ kind: "subtitle-style-position", position }),
      })),
    },
    {
      kind: "submenu",
      title: t("player.mpv.subtitleStyle.color"),
      submenu: (Object.keys(SUBTITLE_COLOR_LABEL_KEYS) as MpvMenuSubtitleStyleValue["color"][]).map((color) => ({
        kind: "radio",
        title: t(SUBTITLE_COLOR_LABEL_KEYS[color]),
        checked: style.color === color,
        id: register({ kind: "subtitle-style-color", color }),
      })),
    },
  ]
  items.push({ kind: "separator" })
  items.push({ kind: "item", title: t("player.controls.reset"), id: register({ kind: "subtitle-style-reset" }) })
  return items
}

function buildRootItems(model: MpvMenuRootModel, register: Register): MenuItem[] {
  const items = titleSection(t("player.controls.settings"))
  if (model.audioTracks.length > 0) {
    items.push({ kind: "submenu", title: t("player.audio"), submenu: audioChoiceItems(model.audioTracks, register) })
  }
  // Subtitles submenu always shows: it's the only way to reach "Load subtitle file…" with zero tracks.
  items.push({ kind: "submenu", title: t("player.subtitles"), submenu: subtitleChoiceItems(model.subtitleTracks, register) })
  items.push({ kind: "submenu", title: t("player.controls.speed"), submenu: speedChoiceItems(model.currentRate, register) })
  items.push({
    kind: "submenu",
    title: t("player.controls.subtitleDelay"),
    submenu: delayChoiceItems("subtitle", register),
  })
  items.push({ kind: "submenu", title: t("player.mpv.audioDelay.label"), submenu: delayChoiceItems("audio", register) })
  items.push({
    kind: "submenu",
    title: t("player.mpv.subtitleStyle.title"),
    submenu: subtitleStyleChoiceItems(model.subtitleStyle, register),
  })
  return items
}

export function buildMpvMenu(kind: "audio", model: MpvMenuAudioModel): MpvMenuBuildResult
export function buildMpvMenu(kind: "subtitles", model: MpvMenuSubtitlesModel): MpvMenuBuildResult
export function buildMpvMenu(kind: "speed", model: MpvMenuSpeedModel): MpvMenuBuildResult
export function buildMpvMenu(kind: "subtitleDelay", model: MpvMenuDelayModel): MpvMenuBuildResult
export function buildMpvMenu(kind: "audioDelay", model: MpvMenuDelayModel): MpvMenuBuildResult
export function buildMpvMenu(kind: "subtitleStyle", model: MpvMenuSubtitleStyleModel): MpvMenuBuildResult
export function buildMpvMenu(kind: "root", model: MpvMenuRootModel): MpvMenuBuildResult
export function buildMpvMenu(
  kind: MpvMenuKind,
  model:
    | MpvMenuAudioModel
    | MpvMenuSubtitlesModel
    | MpvMenuSpeedModel
    | MpvMenuDelayModel
    | MpvMenuSubtitleStyleModel
    | MpvMenuRootModel,
): MpvMenuBuildResult {
  const picks = new Map<number, MpvMenuPick>()
  let nextId = 1
  const register: Register = (pick) => {
    const id = nextId++
    picks.set(id, pick)
    return id
  }

  let items: MenuItem[]
  switch (kind) {
    case "audio":
      items = [...titleSection(t("player.audio")), ...audioChoiceItems((model as MpvMenuAudioModel).tracks, register)]
      break
    case "subtitles":
      items = [...titleSection(t("player.subtitles")), ...subtitleChoiceItems((model as MpvMenuSubtitlesModel).tracks, register)]
      break
    case "speed":
      items = [...titleSection(t("player.controls.speed")), ...speedChoiceItems((model as MpvMenuSpeedModel).currentRate, register)]
      break
    case "subtitleDelay":
      items = buildDelayItems("subtitle", (model as MpvMenuDelayModel).currentSeconds, register)
      break
    case "audioDelay":
      items = buildDelayItems("audio", (model as MpvMenuDelayModel).currentSeconds, register)
      break
    case "subtitleStyle":
      items = [
        ...titleSection(t("player.mpv.subtitleStyle.title")),
        ...subtitleStyleChoiceItems((model as MpvMenuSubtitleStyleModel).style, register),
      ]
      break
    case "root":
    default:
      items = buildRootItems(model as MpvMenuRootModel, register)
      break
  }
  return { items, picks }
}

/** Legacy shape per mpv's own "Context Menu" docs (`menu-data` property), used only as a fallback. */
export interface LegacyMpvMenuItem {
  type?: "" | "checkbox" | "radio" | "separator" | "submenu"
  title?: string
  cmd?: string
  state?: ("checked" | "disabled" | "hidden")[]
  submenu?: LegacyMpvMenuItem[]
}

const LEGACY_MESSAGE_NAME = "xt-menu"

function legacyMenuCommand(id: number): string {
  return `script-message ${LEGACY_MESSAGE_NAME} pick:${id}`
}

/** Converts a `buildMpvMenu` tree into mpv's own `menu-data` shape, for use before `mpv_embed_show_menu` existed. */
export function toLegacyMpvMenuData(items: MenuItem[]): LegacyMpvMenuItem[] {
  return items.map((item): LegacyMpvMenuItem => {
    if (item.kind === "separator") return { type: "separator" }
    if (item.kind === "title") return { type: "", title: item.title, state: ["disabled"] }
    if (item.kind === "submenu") return { type: "submenu", title: item.title, submenu: toLegacyMpvMenuData(item.submenu ?? []) }
    const state: ("checked" | "disabled")[] = []
    if (item.checked) state.push("checked")
    if (item.disabled) state.push("disabled")
    const type = item.kind === "radio" ? "radio" : item.kind === "checkbox" ? "checkbox" : ""
    return { type, title: item.title, state, cmd: item.id != null ? legacyMenuCommand(item.id) : undefined }
  })
}

const LEGACY_PICK_VALUE_PATTERN = /^pick:(\d+)$/

/** Reads the picked item id off a `client-message` event's args; null when the message isn't ours. */
export function parseMpvMenuMessageId(args: string[]): number | null {
  if (args[0] !== LEGACY_MESSAGE_NAME || typeof args[1] !== "string") return null
  const match = LEGACY_PICK_VALUE_PATTERN.exec(args[1])
  if (!match) return null
  return Number(match[1])
}
