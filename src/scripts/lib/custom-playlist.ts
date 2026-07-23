// Custom playlist: document store + pure channel resolver. Channels are
// user-assembled references into other playlists' catalogs (or raw stream
// URLs), persisted as one JSON document per custom-playlist entry.

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
  // Merge into an existing `to` group instead of the naive rename: drop the
  // now-duplicate `from` entry rather than adding a second `to`.
  const groups =
    to !== from && doc.groups.includes(to)
      ? doc.groups.filter((group) => group !== from)
      : doc.groups.map((group) => (group === from ? to : group))
  return { ...doc, groups, channels }
}

export function reorderGroups(doc: CustomPlaylistDoc, orderedGroups: string[]): CustomPlaylistDoc {
  const currentSet = new Set(doc.groups)
  const orderedSet = new Set(orderedGroups)
  const sameSize = currentSet.size === orderedSet.size
  const sameMembers = sameSize && [...currentSet].every((group) => orderedSet.has(group))
  if (!sameMembers) {
    throw new Error("reorderGroups: orderedGroups must contain the same set of groups")
  }
  return { ...doc, groups: [...orderedGroups] }
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

function unresolvedChannel(channel: CustomChannel, fallbackName: string): ResolvedCustomChannel {
  const name = fallbackName || ""
  return {
    id: channel.id,
    name,
    category: channel.group,
    logo: channel.overrides.logo ?? null,
    tvgId: channel.overrides.tvgId ?? undefined,
    chno: channel.overrides.chno ?? undefined,
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
    logo: channel.overrides.logo ?? sourceChannel.logo ?? null,
    tvgId: channel.overrides.tvgId ?? sourceChannel.tvgId,
    chno: channel.overrides.chno ?? sourceChannel.chno,
    norm: normalize(`${name} ${channel.group}`),
    url: pool.buildUrl(source.streamId),
    isRadio: false,
    ...resolveCatchupFields(channel, sourceChannel),
    tvArchive: sourceChannel.tvArchive,
    tvArchiveDuration: sourceChannel.tvArchiveDuration,
    userAgent: sourceChannel.userAgent ?? null,
    referer: sourceChannel.referer ?? null,
    manifestType: sourceChannel.manifestType ?? null,
    drmScheme: sourceChannel.drmScheme ?? null,
    licenseKey: sourceChannel.licenseKey ?? null,
  }
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
        pool.channels.find((poolChannel) => poolChannel.name === source.name)
      : undefined
  if (!pool || !sourceChannel) {
    return unresolvedChannel(channel, channel.overrides.name ?? source.name ?? "")
  }
  const name = channel.overrides.name ?? sourceChannel.name ?? ""
  return {
    id: channel.id,
    name,
    category: channel.group,
    logo: channel.overrides.logo ?? sourceChannel.logo ?? null,
    tvgId: channel.overrides.tvgId ?? sourceChannel.tvgId,
    chno: channel.overrides.chno ?? sourceChannel.chno,
    norm: normalize(`${name} ${channel.group}`),
    url: sourceChannel.url,
    isRadio: !!sourceChannel.isRadio,
    ...resolveCatchupFields(channel, sourceChannel),
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
  const source = channel.sources[0]
  if (!source) return unresolvedChannel(channel, channel.overrides.name ?? "")
  if (source.kind === "xtream") return resolveXtreamSource(channel, source, pools)
  if (source.kind === "m3u") return resolveM3USource(channel, source, pools)
  return resolveDirectSource(channel, source)
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
