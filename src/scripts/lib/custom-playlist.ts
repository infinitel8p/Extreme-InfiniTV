// Custom playlist document store + pure resolver of its references against other playlists' catalogs.

import { getLocalContent, setLocalContent } from "@/scripts/lib/local-content.js"
import { normalize } from "@/scripts/lib/text.ts"

export const UNCATEGORIZED = "Uncategorized"

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
  /** Absent for a normal channel. "header" marks a non-playable title/separator row within a group. */
  kind?: "header"
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

const customDocMutationChains = new Map<string, Promise<unknown>>()

/** Queues load-mutate-save per entryId so concurrent editors can't clobber each other; null return means nothing was saved. */
export function mutateCustomDoc(
  entryId: string,
  mutate: (doc: CustomPlaylistDoc) => CustomPlaylistDoc | Promise<CustomPlaylistDoc | null> | null
): Promise<CustomPlaylistDoc | null> {
  const previous = customDocMutationChains.get(entryId) ?? Promise.resolve()
  const step = previous.catch(() => undefined).then(async (): Promise<CustomPlaylistDoc | null> => {
    const doc = await loadCustomDoc(entryId)
    const result = await mutate(doc)
    if (!result || result === doc) return null
    const saved = await saveCustomDoc(entryId, result)
    if (!saved) throw new Error("saveCustomDoc returned false")
    return result
  })
  customDocMutationChains.set(entryId, step.catch(() => undefined))
  return step
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

export function isHeaderChannel(channel: CustomChannel): boolean {
  return channel.kind === "header"
}

export interface AddHeaderOptions {
  beforeKey?: string | null
}

/** Adds a non-playable title/separator row to a group, inserted before `beforeKey` when given, else appended. */
export function addHeader(
  doc: CustomPlaylistDoc,
  group: string,
  name: string,
  opts: AddHeaderOptions = {}
): CustomPlaylistDoc {
  const header: CustomChannel = {
    key: makeKey(),
    id: doc.nextId,
    group,
    kind: "header",
    sources: [],
    overrides: { name, logo: null, chno: null, tvgId: null },
    catchup: null,
  }
  const groups = doc.groups.includes(group) ? doc.groups : [...doc.groups, group]
  const beforeKey = opts.beforeKey ?? null
  let insertIndex = doc.channels.findIndex((channel) => channel.key === beforeKey)
  if (insertIndex === -1) {
    let lastGroupIndex = -1
    doc.channels.forEach((channel, index) => {
      if (channel.group === group) lastGroupIndex = index
    })
    insertIndex = lastGroupIndex === -1 ? doc.channels.length : lastGroupIndex + 1
  }
  const channels = [...doc.channels.slice(0, insertIndex), header, ...doc.channels.slice(insertIndex)]
  return { ...doc, nextId: doc.nextId + 1, groups, channels }
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
  return moveChannels(doc, [key], beforeKey, group)
}

/** Moves the given channels as a contiguous block, preserving their current relative order. */
export function moveChannels(
  doc: CustomPlaylistDoc,
  keys: string[],
  beforeKey: string | null,
  group: string
): CustomPlaylistDoc {
  const keySet = new Set(keys)
  const selectedChannels = doc.channels.filter((channel) => keySet.has(channel.key))
  if (!selectedChannels.length) return doc

  // Dropping the block onto one of its own members: keep their position, only recolor the group.
  if (beforeKey && keySet.has(beforeKey)) {
    const channels = doc.channels.map((channel) => (keySet.has(channel.key) ? { ...channel, group } : channel))
    const groups = doc.groups.includes(group) ? doc.groups : [...doc.groups, group]
    return { ...doc, channels, groups }
  }

  const movedChannels = selectedChannels.map((channel) => ({ ...channel, group }))
  const remainingChannels = doc.channels.filter((channel) => !keySet.has(channel.key))

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
    ...movedChannels,
    ...remainingChannels.slice(insertIndex),
  ]
  const groups = doc.groups.includes(group) ? doc.groups : [...doc.groups, group]
  return { ...doc, channels, groups }
}

export function moveChannelWithinGroup(
  doc: CustomPlaylistDoc,
  key: string,
  direction: "up" | "down"
): CustomPlaylistDoc {
  const channel = doc.channels.find((item) => item.key === key)
  if (!channel) return doc
  const groupChannels = doc.channels.filter((item) => item.group === channel.group)
  const index = groupChannels.findIndex((item) => item.key === key)
  if (index === -1) return doc
  if (direction === "up") {
    if (index <= 0) return doc
    return moveChannel(doc, key, groupChannels[index - 1].key, channel.group)
  }
  if (index >= groupChannels.length - 1) return doc
  const afterNextIndex = index + 2
  const beforeKey = afterNextIndex < groupChannels.length ? groupChannels[afterNextIndex].key : null
  return moveChannel(doc, key, beforeKey, channel.group)
}

/** Shifts each contiguous run of selected items one step, stopping a run that's already at the edge it's moving toward. */
function shiftSelectedRuns<T>(items: T[], isSelected: (item: T) => boolean, direction: "up" | "down"): T[] {
  const result = [...items]
  const length = result.length
  if (direction === "up") {
    let index = 0
    while (index < length) {
      if (!isSelected(result[index])) {
        index++
        continue
      }
      const runStart = index
      let runEnd = index
      while (runEnd + 1 < length && isSelected(result[runEnd + 1])) runEnd++
      if (runStart > 0) {
        const [moved] = result.splice(runStart - 1, 1)
        result.splice(runEnd, 0, moved)
      }
      index = runEnd + 1
    }
  } else {
    let index = length - 1
    while (index >= 0) {
      if (!isSelected(result[index])) {
        index--
        continue
      }
      const runEnd = index
      let runStart = index
      while (runStart - 1 >= 0 && isSelected(result[runStart - 1])) runStart--
      if (runEnd < length - 1) {
        const [moved] = result.splice(runEnd + 1, 1)
        result.splice(runStart, 0, moved)
      }
      index = runStart - 1
    }
  }
  return result
}

/** Moves the selected channels one step within their respective groups, keeping selected neighbours together. */
export function moveChannelsWithinGroup(
  doc: CustomPlaylistDoc,
  keys: string[],
  direction: "up" | "down"
): CustomPlaylistDoc {
  const keySet = new Set(keys)
  const touchedGroups = new Set(
    doc.channels.filter((channel) => keySet.has(channel.key)).map((channel) => channel.group)
  )
  if (!touchedGroups.size) return doc

  const channels = [...doc.channels]
  let changed = false
  for (const groupName of touchedGroups) {
    const groupPositions: number[] = []
    channels.forEach((channel, index) => {
      if (channel.group === groupName) groupPositions.push(index)
    })
    const groupChannels = groupPositions.map((position) => channels[position])
    const reordered = shiftSelectedRuns(groupChannels, (channel) => keySet.has(channel.key), direction)
    groupPositions.forEach((position, index) => {
      if (channels[position] !== reordered[index]) changed = true
      channels[position] = reordered[index]
    })
  }
  if (!changed) return doc
  return { ...doc, channels }
}

/** Sorts the selected channels into the positions they already occupy, per group. */
export function sortChannels(
  doc: CustomPlaylistDoc,
  keys: string[],
  direction: "asc" | "desc",
  nameOf: (channel: CustomChannel) => string
): CustomPlaylistDoc {
  const keySet = new Set(keys)
  const selectedByGroup = new Map<string, CustomChannel[]>()
  for (const channel of doc.channels) {
    if (!keySet.has(channel.key) || isHeaderChannel(channel)) continue
    const bucket = selectedByGroup.get(channel.group)
    if (bucket) bucket.push(channel)
    else selectedByGroup.set(channel.group, [channel])
  }
  if (!selectedByGroup.size) return doc

  const compare = (left: CustomChannel, right: CustomChannel): number => {
    const result = nameOf(left).localeCompare(nameOf(right), undefined, { sensitivity: "base", numeric: true })
    return direction === "asc" ? result : -result
  }
  const sortedByGroup = new Map<string, CustomChannel[]>()
  for (const [group, groupChannels] of selectedByGroup) {
    sortedByGroup.set(group, [...groupChannels].sort(compare))
  }

  const cursorByGroup = new Map<string, number>()
  const channels = doc.channels.map((channel) => {
    if (!keySet.has(channel.key) || isHeaderChannel(channel)) return channel
    const cursor = cursorByGroup.get(channel.group) ?? 0
    cursorByGroup.set(channel.group, cursor + 1)
    return sortedByGroup.get(channel.group)![cursor]
  })
  return { ...doc, channels }
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

export function clearNameOverrides(doc: CustomPlaylistDoc, keys: string[]): CustomPlaylistDoc {
  const keySet = new Set(keys)
  let changed = false
  const channels = doc.channels.map((channel) => {
    if (!keySet.has(channel.key) || channel.overrides.name === null) return channel
    changed = true
    return { ...channel, overrides: { ...channel.overrides, name: null } }
  })
  return changed ? { ...doc, channels } : doc
}

export function setCatchup(
  doc: CustomPlaylistDoc,
  key: string,
  catchup: CustomChannelCatchup | null
): CustomPlaylistDoc {
  const channels = doc.channels.map((channel) => (channel.key === key ? { ...channel, catchup } : channel))
  return { ...doc, channels }
}

/** Deep copy of a channel's primary source, or null for a header/sourceless channel. */
export function copySourceOf(channel: CustomChannel): CustomSource | null {
  const source = channel.sources[0]
  if (isHeaderChannel(channel) || !source) return null
  return { ...source }
}

/** Identity key for a source reference, used to detect a channel already pulled into the doc. */
export function customSourceKey(source: CustomSource): string {
  if (source.kind === "xtream") return `x:${source.entryId}:${source.streamId}`
  if (source.kind === "m3u") return `m:${source.entryId}:${source.url}`
  return `d:${source.url}`
}

/** Source keys already present in the doc, one entry per channel's primary source. */
export function presentSourceKeys(doc: CustomPlaylistDoc): Set<string> {
  const keys = new Set<string>()
  for (const channel of doc.channels) {
    const source = channel.sources[0]
    if (source) keys.add(customSourceKey(source))
  }
  return keys
}

/** Source keys present per group. */
export function presentSourceKeysByGroup(doc: CustomPlaylistDoc): Map<string, Set<string>> {
  const byGroup = new Map<string, Set<string>>()
  for (const channel of doc.channels) {
    const source = channel.sources[0]
    if (!source) continue
    const key = customSourceKey(source)
    const bucket = byGroup.get(channel.group)
    if (bucket) bucket.add(key)
    else byGroup.set(channel.group, new Set([key]))
  }
  return byGroup
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

/** Removes a group, reassigning its channels to Uncategorized rather than dropping them. */
export function removeGroup(doc: CustomPlaylistDoc, group: string): CustomPlaylistDoc {
  if (!doc.groups.includes(group)) return doc
  const channels = doc.channels.map((channel) =>
    channel.group === group ? { ...channel, group: UNCATEGORIZED } : channel
  )
  const groups = doc.groups.filter((existing) => existing !== group)
  const needsUncategorized = channels.some((channel) => channel.group === UNCATEGORIZED)
  return {
    ...doc,
    groups: needsUncategorized && !groups.includes(UNCATEGORIZED) ? [...groups, UNCATEGORIZED] : groups,
    channels,
  }
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
  isHeader?: true
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

function resolveHeaderChannel(channel: CustomChannel): ResolvedCustomChannel {
  const name = channel.overrides?.name ?? ""
  return {
    id: channel.id,
    name,
    category: channel.group,
    categories: [channel.group],
    logo: null,
    tvgId: undefined,
    chno: undefined,
    norm: normalize(`${name} ${channel.group}`),
    url: "",
    isRadio: false,
    ...resolveCatchupFields(channel, undefined),
    isHeader: true,
  }
}

function resolveChannel(channel: CustomChannel, pools: Map<string, SourcePool>): ResolvedCustomChannel {
  if (isHeaderChannel(channel)) return resolveHeaderChannel(channel)
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
