// Non-destructive per-channel display overrides for provider playlists.
// The provider catalog in the cache stays untouched; these apply on read.
import { normalize } from "@/scripts/lib/text.js"

// Every override lives in the single `xt_prefs` JSON blob that also carries
// favorites and playback progress, and that blob is mirrored into a cookie. An
// unbounded name pasted across a few hundred channels would push the whole blob
// past the quota and silently stop *all* preferences from persisting - so these
// caps are data integrity, not cosmetics.
export const MAX_OVERRIDE_NAME_LENGTH = 120
export const MAX_OVERRIDE_LOGO_LENGTH = 2048
export const MAX_OVERRIDE_CHNO = 99999

/** Collapses whitespace and caps length; "" means "no override". */
export function sanitizeOverrideName(raw: unknown): string {
  if (typeof raw !== "string") return ""
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_OVERRIDE_NAME_LENGTH)
}

/**
 * http(s) and inline images only. A `javascript:` or `blob:` value would never
 * render anyway, so rejecting it here keeps junk out of storage and lets the
 * dialog say so instead of saving something that silently fails.
 */
export function sanitizeOverrideLogo(raw: unknown): string {
  if (typeof raw !== "string") return ""
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_OVERRIDE_LOGO_LENGTH) return ""
  if (/^data:image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml);/i.test(trimmed)) return trimmed
  try {
    const parsed = new URL(trimmed)
    return /^https?:$/.test(parsed.protocol) ? parsed.href : ""
  } catch {
    return ""
  }
}

/** @returns null when the value isn't a usable channel number. */
export function sanitizeOverrideChno(raw: unknown): number | null {
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  const floored = Math.floor(value)
  if (floored < 1 || floored > MAX_OVERRIDE_CHNO) return null
  return floored
}

export interface ChannelOverride {
  name?: string
  logo?: string
  chno?: number
  hidden?: boolean
  /** Identity aids for re-matching after a provider change, never displayed. */
  srcName?: string
  srcTvgId?: string
}

export type ChannelOverrideMap = Record<string, ChannelOverride>

export interface OverridableChannel {
  id: number | string
  name?: string
  logo?: string | null
  chno?: number | null
  tvgId?: string | null
  url?: string | null
  category?: string | null
  norm?: string
  [key: string]: unknown
}

/**
 * Content-derived identity for a channel. Never the runtime id for M3U sources:
 * those ids are a positional counter, so one added provider line shifts them all
 * and id-keyed overrides would silently land on the wrong channels.
 */
export function channelOverrideKey(channel: OverridableChannel, isM3U: boolean): string {
  if (!channel) return ""
  if (!isM3U) {
    const id = channel.id
    return id == null || id === "" ? "" : `x:${id}`
  }
  const url = typeof channel.url === "string" ? channel.url.trim() : ""
  if (url) return `u:${url}`
  const tvgId = typeof channel.tvgId === "string" ? channel.tvgId.trim() : ""
  if (tvgId) return `t:${tvgId}`
  const name = normalize(channel.name || "")
  return name ? `n:${name}` : ""
}

export interface OverriddenChannel extends OverridableChannel {
  /** Present when any display field came from an override. */
  overrideKey?: string
  hidden?: boolean
}

/**
 * The key to write an override under. An already-overridden channel carries the
 * key it was matched by: re-deriving it would hash the *new* name for a
 * name-keyed channel and orphan the record it came from.
 */
export function resolveOverrideKey(channel: OverriddenChannel, isM3U: boolean): string {
  return channel?.overrideKey || channelOverrideKey(channel, isM3U)
}

/** The identity fields stored alongside an override so it can be re-matched later. */
export function overrideIdentity(channel: OverridableChannel): {
  srcName: string | null
  srcTvgId: string | null
} {
  const srcName = typeof channel?.name === "string" ? channel.name.trim() : ""
  const srcTvgId = typeof channel?.tvgId === "string" ? channel.tvgId.trim() : ""
  return { srcName: srcName || null, srcTvgId: srcTvgId || null }
}

export function hasVisibleOverride(record: ChannelOverride | null | undefined): boolean {
  if (!record) return false
  return !!record.name || !!record.logo || record.chno != null || record.hidden === true
}

/**
 * tvg-id index used only as a fallback when a key stops matching (a provider
 * rotating a token in the stream URL changes the key). Built only from ids that
 * are unambiguous on both sides, so SD/HD variants sharing a tvg-id - and two
 * records claiming the same one - can never adopt each other's edits.
 */
function buildTvgFallbackIndex(
  channels: OverridableChannel[],
  overrides: ChannelOverrideMap,
  claimedKeys: Set<string>
): Map<string, string> {
  const recordsByTvg = new Map<string, string[]>()
  for (const [key, record] of Object.entries(overrides)) {
    if (claimedKeys.has(key)) continue
    const tvgId = record?.srcTvgId?.trim()
    if (!tvgId) continue
    const bucket = recordsByTvg.get(tvgId)
    if (bucket) bucket.push(key)
    else recordsByTvg.set(tvgId, [key])
  }
  if (!recordsByTvg.size) return new Map()

  const channelCounts = new Map<string, number>()
  for (const channel of channels) {
    const tvgId = typeof channel?.tvgId === "string" ? channel.tvgId.trim() : ""
    if (!tvgId || !recordsByTvg.has(tvgId)) continue
    channelCounts.set(tvgId, (channelCounts.get(tvgId) || 0) + 1)
  }

  const index = new Map<string, string>()
  for (const [tvgId, keys] of recordsByTvg) {
    if (keys.length !== 1) continue
    if (channelCounts.get(tvgId) !== 1) continue
    index.set(tvgId, keys[0])
  }
  return index
}

export interface ApplyOverridesOptions {
  isM3U: boolean
  /** Keep hidden channels in the result (the management UI needs them). */
  includeHidden?: boolean
}

/**
 * Overlays `overrides` onto `channels`. Returns the input array unchanged when
 * there is nothing to apply, so the common no-overrides path costs one check.
 */
export function applyChannelOverrides<Channel extends OverridableChannel>(
  channels: Channel[],
  overrides: ChannelOverrideMap | null | undefined,
  options: ApplyOverridesOptions
): (Channel & OverriddenChannel)[] {
  const list = Array.isArray(channels) ? channels : []
  if (!overrides || !Object.keys(overrides).length) {
    return list as (Channel & OverriddenChannel)[]
  }
  const { isM3U, includeHidden = false } = options

  const claimedKeys = new Set<string>()
  const keyed: (string | null)[] = list.map((channel) => {
    const key = channelOverrideKey(channel, isM3U)
    if (key && overrides[key]) {
      claimedKeys.add(key)
      return key
    }
    return null
  })
  const tvgFallback = buildTvgFallbackIndex(list, overrides, claimedKeys)

  const out: (Channel & OverriddenChannel)[] = []
  for (let index = 0; index < list.length; index++) {
    const channel = list[index]
    let key = keyed[index]
    if (!key && tvgFallback.size) {
      const tvgId = typeof channel?.tvgId === "string" ? channel.tvgId.trim() : ""
      const fallbackKey = tvgId ? tvgFallback.get(tvgId) : undefined
      if (fallbackKey && !claimedKeys.has(fallbackKey)) {
        key = fallbackKey
        claimedKeys.add(fallbackKey)
      }
    }
    const record = key ? overrides[key] : null
    if (!record || !hasVisibleOverride(record)) {
      out.push(channel as Channel & OverriddenChannel)
      continue
    }
    if (record.hidden && !includeHidden) continue

    const next: Channel & OverriddenChannel = { ...channel, overrideKey: key as string }
    if (record.name) {
      next.name = record.name
      // norm backs every search and filter box, so it has to follow the new name.
      next.norm = normalize(`${record.name} ${channel.category || ""} ${channel.tvgId || ""}`)
    }
    if (record.logo) next.logo = record.logo
    if (record.chno != null) next.chno = record.chno
    if (record.hidden) next.hidden = true
    out.push(next)
  }
  return out
}

/** Strips a leading and/or trailing affix, tolerating the surrounding whitespace. */
export function stripAffix(name: string, prefix: string, suffix: string): string {
  let out = typeof name === "string" ? name : ""
  const head = (prefix || "").trim()
  const tail = (suffix || "").trim()
  if (head && out.trimStart().toLowerCase().startsWith(head.toLowerCase())) {
    out = out.trimStart().slice(head.length)
  }
  if (tail && out.trimEnd().toLowerCase().endsWith(tail.toLowerCase())) {
    out = out.trimEnd().slice(0, out.trimEnd().length - tail.length)
  }
  return out.trim()
}

export interface BulkRenameEntry {
  key: string
  from: string
  to: string
  srcName: string | null
  srcTvgId: string | null
}

/**
 * Pure preview for the bulk affix strip: which channels change and to what.
 * Skips no-ops and anything that would strip a name down to nothing.
 */
export function planAffixStrip(
  channels: OverridableChannel[],
  prefix: string,
  suffix: string,
  isM3U: boolean
): BulkRenameEntry[] {
  if (!(prefix || "").trim() && !(suffix || "").trim()) return []
  const out: BulkRenameEntry[] = []
  for (const channel of Array.isArray(channels) ? channels : []) {
    const from = typeof channel?.name === "string" ? channel.name : ""
    if (!from) continue
    const to = stripAffix(from, prefix, suffix)
    if (!to || to === from) continue
    // resolveOverrideKey: a second strip pass over an already-renamed name-keyed
    // channel must land on the record it came from, not mint a new one.
    const key = resolveOverrideKey(channel, isM3U)
    if (!key) continue
    const identity = overrideIdentity(channel)
    out.push({ key, from, to, srcName: identity.srcName, srcTvgId: identity.srcTvgId })
  }
  return out
}
