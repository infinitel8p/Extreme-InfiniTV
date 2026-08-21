// Pure cast-descriptor shapes shared by the sender (build) and the TV receiver (validate).
import { chooseMime } from "@/scripts/lib/morph-detail.js"

export interface CastDescriptorV1 {
  v: 1
  src: string
  mime: string
  isLive: boolean
  title: string
  logo?: string
  drm?: { manifestType?: string | null; drmScheme?: string | null; licenseKey?: string | null }
  headers?: { userAgent?: string | null; referer?: string | null }
  resumeSeconds?: number
  durationSeconds?: number
  timelineOffsetSeconds?: number
  preferNativeHls?: boolean
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "tauri.localhost"])

export function isCastableSrc(src: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(src)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  return !LOCAL_HOSTS.has(parsed.hostname.toLowerCase())
}

function clampNonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

interface BuildLiveCastDescriptorInput {
  src: string
  title: string
  logo?: string
  drm?: CastDescriptorV1["drm"]
  headers?: CastDescriptorV1["headers"]
  preferNativeHls?: boolean
}

export function buildLiveCastDescriptor(input: BuildLiveCastDescriptorInput): CastDescriptorV1 {
  const descriptor: CastDescriptorV1 = {
    v: 1,
    src: input.src,
    mime: "application/x-mpegURL",
    isLive: true,
    title: input.title,
  }
  if (input.logo !== undefined) descriptor.logo = input.logo
  if (input.drm !== undefined) descriptor.drm = input.drm
  if (input.headers !== undefined) descriptor.headers = input.headers
  if (input.preferNativeHls !== undefined) descriptor.preferNativeHls = input.preferNativeHls
  return descriptor
}

interface BuildVodCastDescriptorInput {
  src: string
  title: string
  logo?: string
  resumeSeconds?: number
  durationSeconds?: number
}

export function buildVodCastDescriptor(input: BuildVodCastDescriptorInput): CastDescriptorV1 {
  const descriptor: CastDescriptorV1 = {
    v: 1,
    src: input.src,
    mime: chooseMime(input.src),
    isLive: false,
    title: input.title,
  }
  if (input.logo !== undefined) descriptor.logo = input.logo
  const resumeSeconds = clampNonNegativeFinite(input.resumeSeconds)
  if (resumeSeconds !== undefined) descriptor.resumeSeconds = resumeSeconds
  const durationSeconds = clampNonNegativeFinite(input.durationSeconds)
  if (durationSeconds !== undefined) descriptor.durationSeconds = durationSeconds
  return descriptor
}

interface BuildCatchupCastDescriptorInput {
  src: string
  mime: string
  title: string
  logo?: string
  headers?: CastDescriptorV1["headers"]
  resumeSeconds?: number
  durationSeconds?: number
  timelineOffsetSeconds?: number
}

export function buildCatchupCastDescriptor(input: BuildCatchupCastDescriptorInput): CastDescriptorV1 {
  const descriptor: CastDescriptorV1 = {
    v: 1,
    src: input.src,
    mime: input.mime,
    isLive: false,
    title: input.title,
  }
  if (input.logo !== undefined) descriptor.logo = input.logo
  if (input.headers !== undefined) descriptor.headers = input.headers
  const resumeSeconds = clampNonNegativeFinite(input.resumeSeconds)
  if (resumeSeconds !== undefined) descriptor.resumeSeconds = resumeSeconds
  const durationSeconds = clampNonNegativeFinite(input.durationSeconds)
  if (durationSeconds !== undefined) descriptor.durationSeconds = durationSeconds
  const timelineOffsetSeconds = clampNonNegativeFinite(input.timelineOffsetSeconds)
  if (timelineOffsetSeconds !== undefined) descriptor.timelineOffsetSeconds = timelineOffsetSeconds
  return descriptor
}

interface DeriveSessionIsLiveContext {
  liveContext?: unknown
}

/** Live-channel casts stay live even if a shipped-with-duration catch-up descriptor never reaches here. */
export function deriveSessionIsLive(
  descriptor: Pick<CastDescriptorV1, "isLive" | "durationSeconds">,
  context?: DeriveSessionIsLiveContext
): boolean {
  return descriptor.isLive || (Boolean(context?.liveContext) && descriptor.durationSeconds === undefined)
}

function pickKnownStringOrNullFields<Key extends string>(
  value: unknown,
  keys: readonly Key[]
): Partial<Record<Key, string | null>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const result: Partial<Record<Key, string | null>> = {}
  let hasKnownField = false
  for (const key of keys) {
    const fieldValue = source[key]
    if (typeof fieldValue === "string" || fieldValue === null) {
      result[key] = fieldValue
      hasKnownField = true
    }
  }
  return hasKnownField ? result : undefined
}

const DRM_FIELDS = ["manifestType", "drmScheme", "licenseKey"] as const
const HEADERS_FIELDS = ["userAgent", "referer"] as const

/** Receiver-side guard: strips unknown fields, drops invalid optionals, returns null on any structural mismatch. */
export function validateCastDescriptor(value: unknown): CastDescriptorV1 | null {
  if (!value || typeof value !== "object") return null
  const source = value as Record<string, unknown>
  if (source.v !== 1) return null
  if (typeof source.src !== "string" || !isCastableSrc(source.src)) return null
  if (typeof source.mime !== "string" || source.mime === "") return null
  if (typeof source.title !== "string") return null
  if (typeof source.isLive !== "boolean") return null

  const descriptor: CastDescriptorV1 = {
    v: 1,
    src: source.src,
    mime: source.mime,
    isLive: source.isLive,
    title: source.title,
  }
  if (typeof source.logo === "string" && source.logo !== "") descriptor.logo = source.logo

  const drm = pickKnownStringOrNullFields(source.drm, DRM_FIELDS)
  if (drm) descriptor.drm = drm

  const headers = pickKnownStringOrNullFields(source.headers, HEADERS_FIELDS)
  if (headers) descriptor.headers = headers

  const resumeSeconds = clampNonNegativeFinite(source.resumeSeconds)
  if (resumeSeconds !== undefined) descriptor.resumeSeconds = resumeSeconds

  const durationSeconds = clampNonNegativeFinite(source.durationSeconds)
  if (durationSeconds !== undefined) descriptor.durationSeconds = durationSeconds

  const timelineOffsetSeconds = clampNonNegativeFinite(source.timelineOffsetSeconds)
  if (timelineOffsetSeconds !== undefined) descriptor.timelineOffsetSeconds = timelineOffsetSeconds

  if (typeof source.preferNativeHls === "boolean") descriptor.preferNativeHls = source.preferNativeHls

  return descriptor
}
