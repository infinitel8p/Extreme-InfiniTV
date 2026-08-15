// Custom playlist document store + pure resolver of its references against other playlists' catalogs.

import { getLocalContent, setLocalContent } from "@/scripts/lib/local-content.js"
import { normalize } from "@/scripts/lib/text.ts"

const UNCATEGORIZED = "Uncategorized"

export interface CustomSourceXtream {
  kind: "xtream"
  entryId: string
  streamId: number
}

export interface CustomSourceM3U {
  kind: "m3u"
  entryId: string
  url: string
  name: string
}

export interface CustomSourceDirect {
  kind: "direct"
  url: string
  userAgent: string | null
  referer: string | null
  manifestType: string | null
  drmScheme: string | null
  licenseKey: string | null
}

export type CustomSource = CustomSourceXtream | CustomSourceM3U | CustomSourceDirect

export interface CustomChannelOverrides {
  name: string | null
  logo: string | null
  chno: number | null
  tvgId: string | null
}

export interface CustomChannelCatchup {
  catchup: string | null
  catchupDays: number | null
  catchupSource: string | null
  catchupCorrection: number | null
}

export interface CustomChannel {
  key: string
  id: number
  group: string
  sources: CustomSource[]
  overrides: CustomChannelOverrides
  catchup: CustomChannelCatchup | null
}

export interface CustomPlaylistDoc {
  version: 1
  nextId: number
  groups: string[]
  channels: CustomChannel[]
}

export interface AddChannelInit {
  name?: string | null
  logo?: string | null
  group?: string | null
  tvgId?: string | null
  chno?: number | null
  catchup?: CustomChannelCatchup | null
}

function makeKey(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function emptyCustomDoc(): CustomPlaylistDoc {
  return { version: 1, nextId: 1, groups: [], channels: [] }
}

function isValidDoc(value: unknown): value is CustomPlaylistDoc {
  if (!value || typeof value !== "object") return false
  const doc = value as Record<string, unknown>
  return Array.isArray(doc.groups) && Array.isArray(doc.channels) && typeof doc.nextId === "number"
}

export async function loadCustomDoc(entryId: string): Promise<CustomPlaylistDoc> {
  const text = await getLocalContent(entryId)
  if (text === null) throw new Error("loadCustomDoc: storage read failed")
  if (!text) return emptyCustomDoc()
  try {
    const parsed = JSON.parse(text)
    return isValidDoc(parsed) ? parsed : emptyCustomDoc()
  } catch {
    return emptyCustomDoc()
  }
}

export async function saveCustomDoc(entryId: string, doc: CustomPlaylistDoc): Promise<boolean> {
  return setLocalContent(entryId, JSON.stringify(doc))
}

export function addChannel(
  doc: CustomPlaylistDoc,
  source: CustomSource,
  init: AddChannelInit = {}
): { doc: CustomPlaylistDoc; channel: CustomChannel } {
  const group = init.group || UNCATEGORIZED
  const channel: CustomChannel = {
    key: makeKey(),
    id: doc.nextId,
    group,
    sources: [source],
    overrides: {
      name: init.name ?? null,
      logo: init.logo ?? null,
      chno: init.chno ?? null,
      tvgId: init.tvgId ?? null,
    },
    catchup: init.catchup ?? null,
  }
  const groups = doc.groups.includes(group) ? doc.groups : [...doc.groups, group]
  const newDoc: CustomPlaylistDoc = {
    ...doc,
    nextId: doc.nextId + 1,
    groups,
    channels: [...doc.channels, channel],
  }
  return { doc: newDoc, channel }
}

export function removeChannels(doc: CustomPlaylistDoc, keys: string[]): CustomPlaylistDoc {
  const removedKeys = new Set(keys)
  const channels = doc.channels.filter((channel) => !removedKeys.has(channel.key))
  const remainingGroups = new Set(channels.map((channel) => channel.group))
  const groups = doc.groups.filter((group) => remainingGroups.has(group))
  return { ...doc, channels, groups }
}

export function moveChannel(
  doc: CustomPlaylistDoc,
  key: string,
  beforeKey: string | null,
  group: string
): CustomPlaylistDoc {
  const channelIndex = doc.channels.findIndex((channel) => channel.key === key)
  if (channelIndex === -1) return doc
  const movedChannel: CustomChannel = { ...doc.channels[channelIndex], group }
  const remainingChannels = doc.channels.filter((channel) => channel.key !== key)

  let insertIndex: number
  if (beforeKey) {
    insertIndex = remainingChannels.findIndex((channel) => channel.key === beforeKey)
    if (insertIndex === -1) insertIndex = remainingChannels.length
  } else {
    let lastGroupIndex = -1
    remainingChannels.forEach((channel, index) => {
      if (channel.group === group) lastGroupIndex = index
    })
    insertIndex = lastGroupIndex === -1 ? remainingChannels.length : lastGroupIndex + 1
  }

  const channels = [
    ...remainingChannels.slice(0, insertIndex),
    movedChannel,
    ...remainingChannels.slice(insertIndex),
  ]
  const groups = doc.groups.includes(group) ? doc.groups : [...doc.groups, group]
  return { ...doc, channels, groups }
}

export function setOverrides(
  doc: CustomPlaylistDoc,
  key: string,
  patch: Partial<CustomChannelOverrides>
): CustomPlaylistDoc {
  const channels = doc.channels.map((channel) =>
    channel.key === key ? { ...channel, overrides: { ...channel.overrides, ...patch } } : channel
  )
  return { ...doc, channels }
}

export function setCatchup(
  doc: CustomPlaylistDoc,
  key: string,
  catchup: CustomChannelCatchup | null
): CustomPlaylistDoc {
  const channels = doc.channels.map((channel) => (channel.key === key ? { ...channel, catchup } : channel))
  return { ...doc, channels }
}

export function setChannelGroup(doc: CustomPlaylistDoc, keys: string[], group: string): CustomPlaylistDoc {
  const targetKeys = new Set(keys)
  const channels = doc.channels.map((channel) =>
    targetKeys.has(channel.key) ? { ...channel, group } : channel
  )
  const groups = doc.groups.includes(group) ? doc.groups : [...doc.groups, group]
  return { ...doc, channels, groups }
}

export function renameGroup(doc: CustomPlaylistDoc, from: string, to: string): CustomPlaylistDoc {
  const channels = doc.channels.map((channel) =>
    channel.group === from ? { ...channel, group: to } : channel
  )
  // Renaming onto an existing group merges into it rather than adding a second `to`.
  const groups =
    to !== from && doc.groups.includes(to)
      ? doc.groups.filter((group) => group !== from)
      : doc.groups.map((group) => (group === from ? to : group))
  return { ...doc, groups, channels }
}

export function reorderGroups(doc: CustomPlaylistDoc, orderedGroups: string[]): CustomPlaylistDoc {
  const currentSet = new Set(doc.groups)
  const orderedSet = new Set(orderedGroups)
  const noDuplicates = orderedGroups.length === orderedSet.size
  const sameSize = currentSet.size === orderedSet.size
  const sameMembers = sameSize && [...currentSet].every((group) => orderedSet.has(group))
  if (!noDuplicates || !sameMembers) {
    throw new Error("reorderGroups: orderedGroups must contain the same set of groups")
  }
  return { ...doc, groups: [...orderedGroups] }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Playlist entry ids a custom doc's channels resolve against. */
export function collectSourceEntryIds(doc: CustomPlaylistDoc): string[] {
  const entryIds = new Set<string>()
  for (const channel of doc?.channels || []) {
    if (!Array.isArray(channel?.sources)) continue
    for (const source of channel.sources) {
      if (!source || typeof source !== "object") continue
      if ((source.kind === "xtream" || source.kind === "m3u") && source.entryId) {
        entryIds.add(source.entryId)
      }
    }
  }
  return [...entryIds]
}

export interface CustomDependency {
  entryId: string
  sourceEntryIds: string[]
}

/** Custom entries whose resolved catalog depends on `sourceEntryId`, walking custom-on-custom references without looping. */
export function collectDependentCustomEntryIds(
  sourceEntryId: string,
  dependencies: CustomDependency[]
): string[] {
  if (!sourceEntryId) return []
  const dependentsBySource = new Map<string, string[]>()
  for (const dependency of dependencies || []) {
    if (!dependency?.entryId || !Array.isArray(dependency.sourceEntryIds)) continue
    for (const referencedId of dependency.sourceEntryIds) {
      if (!referencedId) continue
      const dependents = dependentsBySource.get(referencedId)
      if (dependents) dependents.push(dependency.entryId)
      else dependentsBySource.set(referencedId, [dependency.entryId])
    }
  }
  const visited = new Set<string>([sourceEntryId])
  const queue = [sourceEntryId]
  const out: string[] = []
  while (queue.length) {
    const current = queue.shift() as string
    for (const dependent of dependentsBySource.get(current) || []) {
      if (visited.has(dependent)) continue
      visited.add(dependent)
      out.push(dependent)
      queue.push(dependent)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Pure resolver
// ---------------------------------------------------------------------------

export interface XtreamSourcePool {
  kind: "xtream"
  channels: Array<any>
  buildUrl: (streamId: number) => string
}

export interface M3USourcePool {
  kind: "m3u"
  channels: Array<any>
}

export type SourcePool = XtreamSourcePool | M3USourcePool

export interface ResolvedCustomChannel {
  id: number
  name: string
  category: string
  // Always single-element: custom channels have exactly one group, unlike M3U/Xtream's multi-group shape.
  categories: string[]
  logo: string | null
  tvgId: string | undefined
  chno: number | undefined
  norm: string
  url: string
  isRadio: boolean
  catchup: string | null
  catchupDays: number | null
  catchupSource: string | null
  catchupCorrection: number | null
  tvgShift?: number | null
  tvArchive?: number
  tvArchiveDuration?: number
  userAgent?: string | null
  referer?: string | null
  manifestType?: string | null
  drmScheme?: string | null
  licenseKey?: string | null
  unresolved?: true
}

function resolveCatchupFields(channel: CustomChannel, sourceChannel: any): CustomChannelCatchup {
  if (channel.catchup) return { ...channel.catchup }
  return {
    catchup: sourceChannel?.catchup ?? null,
    catchupDays: sourceChannel?.catchupDays ?? null,
    catchupSource: sourceChannel?.catchupSource ?? null,
    catchupCorrection: sourceChannel?.catchupCorrection ?? null,
  }
}

/** Xtream live channels carry tvArchive/tvArchiveDuration, not a `.catchup` field; map that to the "xc" mode catchup-resolve.ts expects for Xtream-style URLs. */
function resolveXtreamCatchupFields(channel: CustomChannel, sourceChannel: any): CustomChannelCatchup {
  if (channel.catchup) return { ...channel.catchup }
  if (Number(sourceChannel?.tvArchive) === 1) {
    return {
      catchup: "xc",
      catchupDays: sourceChannel?.tvArchiveDuration ?? null,
      catchupSource: null,
      catchupCorrection: null,
    }
  }
  return resolveCatchupFields(channel, sourceChannel)
}

function unresolvedChannel(channel: CustomChannel, fallbackName: string): ResolvedCustomChannel {
  const name = fallbackName || ""
  return {
    id: channel.id,
    name,
    category: channel.group,
    categories: [channel.group],
    logo: channel.overrides?.logo ?? null,
    tvgId: channel.overrides?.tvgId ?? undefined,
    chno: channel.overrides?.chno ?? undefined,
    norm: normalize(`${name} ${channel.group}`),
    url: "",
    isRadio: false,
    ...resolveCatchupFields(channel, undefined),
    unresolved: true,
  }
}

function resolveXtreamSource(
  channel: CustomChannel,
  source: CustomSourceXtream,
  pools: Map<string, SourcePool>
): ResolvedCustomChannel {
  const pool = pools.get(source.entryId)
  if (!pool || pool.kind !== "xtream") {
    return unresolvedChannel(channel, channel.overrides.name ?? "")
  }
  const sourceChannel = pool.channels.find((poolChannel) => poolChannel.id === source.streamId)
  if (!sourceChannel) {
    return unresolvedChannel(channel, channel.overrides.name ?? "")
  }
  const name = channel.overrides.name ?? sourceChannel.name ?? ""
  return {
    id: channel.id,
    name,
    category: channel.group,
    categories: [channel.group],
    logo: channel.overrides.logo ?? sourceChannel.logo ?? null,
    tvgId: channel.overrides.tvgId ?? sourceChannel.tvgId,
    chno: channel.overrides.chno ?? sourceChannel.chno,
    norm: normalize(`${name} ${channel.group}`),
    url: pool.buildUrl(source.streamId),
    isRadio: false,
    ...resolveXtreamCatchupFields(channel, sourceChannel),
    tvgShift: sourceChannel.tvgShift ?? null,
    tvArchive: sourceChannel.tvArchive,
    tvArchiveDuration: sourceChannel.tvArchiveDuration,
    userAgent: sourceChannel.userAgent ?? null,
    referer: sourceChannel.referer ?? null,
    manifestType: sourceChannel.manifestType ?? null,
    drmScheme: sourceChannel.drmScheme ?? null,
    licenseKey: sourceChannel.licenseKey ?? null,
  }
}

/** Name-match fallback (M3U URLs rotate session tokens), but only when the name is unique in the pool. */
function findByUniqueName(channels: Array<any>, name: string): any | undefined {
  const matches = channels.filter((poolChannel) => poolChannel.name === name)
  return matches.length === 1 ? matches[0] : undefined
}

function resolveM3USource(
  channel: CustomChannel,
  source: CustomSourceM3U,
  pools: Map<string, SourcePool>
): ResolvedCustomChannel {
  const pool = pools.get(source.entryId)
  const sourceChannel =
    pool && pool.kind === "m3u"
      ? pool.channels.find((poolChannel) => poolChannel.url === source.url) ??
        findByUniqueName(pool.channels, source.name)
      : undefined
  if (!pool || !sourceChannel) {
    return unresolvedChannel(channel, channel.overrides.name ?? source.name ?? "")
  }
  const name = channel.overrides.name ?? sourceChannel.name ?? ""
  return {
    id: channel.id,
    name,
    category: channel.group,
    categories: [channel.group],
    logo: channel.overrides.logo ?? sourceChannel.logo ?? null,
    tvgId: channel.overrides.tvgId ?? sourceChannel.tvgId,
    chno: channel.overrides.chno ?? sourceChannel.chno,
    norm: normalize(`${name} ${channel.group}`),
    url: sourceChannel.url,
    isRadio: !!sourceChannel.isRadio,
    ...resolveCatchupFields(channel, sourceChannel),
    tvgShift: sourceChannel.tvgShift ?? null,
    userAgent: sourceChannel.userAgent ?? null,
    referer: sourceChannel.referer ?? null,
    manifestType: sourceChannel.manifestType ?? null,
    drmScheme: sourceChannel.drmScheme ?? null,
    licenseKey: sourceChannel.licenseKey ?? null,
  }
}

function resolveDirectSource(channel: CustomChannel, source: CustomSourceDirect): ResolvedCustomChannel {
  const name = channel.overrides.name ?? ""
  return {
    id: channel.id,
    name,
    category: channel.group,
    categories: [channel.group],
    logo: channel.overrides.logo ?? null,
    tvgId: channel.overrides.tvgId ?? undefined,
    chno: channel.overrides.chno ?? undefined,
    norm: normalize(`${name} ${channel.group}`),
    url: source.url,
    isRadio: false,
    ...resolveCatchupFields(channel, undefined),
    userAgent: source.userAgent ?? null,
    referer: source.referer ?? null,
    manifestType: source.manifestType ?? null,
    drmScheme: source.drmScheme ?? null,
    licenseKey: source.licenseKey ?? null,
  }
}

function resolveChannel(channel: CustomChannel, pools: Map<string, SourcePool>): ResolvedCustomChannel {
  const source = Array.isArray(channel.sources) ? channel.sources[0] : undefined
  if (!source || typeof source !== "object") {
    return unresolvedChannel(channel, channel.overrides?.name ?? "")
  }
  if (source.kind === "xtream") return resolveXtreamSource(channel, source, pools)
  if (source.kind === "m3u") return resolveM3USource(channel, source, pools)
  if (source.kind === "direct") return resolveDirectSource(channel, source)
  return unresolvedChannel(channel, channel.overrides?.name ?? "")
}

function orderChannelsByGroup(doc: CustomPlaylistDoc): CustomChannel[] {
  const buckets = new Map<string, CustomChannel[]>(doc.groups.map((group) => [group, []]))
  const stray: CustomChannel[] = []
  for (const channel of doc.channels) {
    const bucket = buckets.get(channel.group)
    if (bucket) bucket.push(channel)
    else stray.push(channel)
  }
  return [...doc.groups.flatMap((group) => buckets.get(group) || []), ...stray]
}

export function resolveCustomChannels(
  doc: CustomPlaylistDoc,
  pools: Map<string, SourcePool>
): ResolvedCustomChannel[] {
  return orderChannelsByGroup(doc).map((channel) => resolveChannel(channel, pools))
}
