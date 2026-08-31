// Pure pixel math for per-title ambient colour: dominant-colour extraction + OKLCH shaping.

export interface RgbColor {
  r: number
  g: number
  b: number
}

export interface OklchColor {
  l: number
  c: number
  h: number
}

const NEAR_BLACK_MAX_LUMA = 18
const NEAR_WHITE_MIN_LUMA = 245
const ALPHA_MIN = 32
const BUCKET_SHIFT = 4 // 4 bits/channel -> 16 levels, coarse enough to find a dominant hue cheaply
const MONOCHROME_WEIGHT_THRESHOLD = 10

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * Coarse 4-bit-per-channel histogram over `rgbaBytes`, weighted by saturation
 * (max-min channel spread) and excluding near-black/near-white/transparent
 * pixels. Returns the winning bucket's representative colour, or null when
 * the sampled image has no meaningfully chromatic pixels.
 */
export function dominantColor(
  rgbaBytes: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): RgbColor | null {
  const pixelCount = width * height
  if (pixelCount <= 0 || rgbaBytes.length < pixelCount * 4) return null

  const bucketWeight = new Map<number, number>()
  const bucketR = new Map<number, number>()
  const bucketG = new Map<number, number>()
  const bucketB = new Map<number, number>()
  let totalWeight = 0
  let consideredPixels = 0

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4
    const alpha = rgbaBytes[offset + 3]
    if (alpha < ALPHA_MIN) continue
    const r = rgbaBytes[offset]
    const g = rgbaBytes[offset + 1]
    const b = rgbaBytes[offset + 2]
    const brightness = luma(r, g, b)
    if (brightness <= NEAR_BLACK_MAX_LUMA || brightness >= NEAR_WHITE_MIN_LUMA) continue

    consideredPixels++
    const saturation = Math.max(r, g, b) - Math.min(r, g, b)
    const weight = saturation + 1
    totalWeight += weight

    const key = ((r >> BUCKET_SHIFT) << 8) | ((g >> BUCKET_SHIFT) << 4) | (b >> BUCKET_SHIFT)
    bucketWeight.set(key, (bucketWeight.get(key) || 0) + weight)
    bucketR.set(key, (bucketR.get(key) || 0) + r * weight)
    bucketG.set(key, (bucketG.get(key) || 0) + g * weight)
    bucketB.set(key, (bucketB.get(key) || 0) + b * weight)
  }

  if (consideredPixels === 0) return null
  if (totalWeight / consideredPixels < MONOCHROME_WEIGHT_THRESHOLD) return null

  let bestKey = -1
  let bestWeight = 0
  for (const [key, weight] of bucketWeight) {
    if (weight > bestWeight) {
      bestWeight = weight
      bestKey = key
    }
  }
  if (bestKey === -1) return null

  return {
    r: Math.round((bucketR.get(bestKey) || 0) / bestWeight),
    g: Math.round((bucketG.get(bestKey) || 0) / bestWeight),
    b: Math.round((bucketB.get(bestKey) || 0) / bestWeight),
  }
}

function srgbToLinear(channel: number): number {
  const normalized = channel / 255
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
}

/** sRGB (0-255) -> OKLCH, per Björn Ottosson's OKLab reference matrices. */
export function rgbToOklch(rgb: RgbColor): OklchColor {
  const r = srgbToLinear(rgb.r)
  const g = srgbToLinear(rgb.g)
  const b = srgbToLinear(rgb.b)

  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  const l = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const okB = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_

  const c = Math.sqrt(a * a + okB * okB)
  const h = c < 1e-6 ? 0 : (Math.atan2(okB, a) * 180) / Math.PI
  return { l, c, h: h < 0 ? h + 360 : h }
}

export interface ToAmbientOptions {
  /** Lightness clamp range; defaults to the dark-theme band. */
  lightness?: [number, number]
  maxChroma?: number
}

const DARK_LIGHTNESS_RANGE: [number, number] = [0.35, 0.62]
const DEFAULT_MAX_CHROMA = 0.09

/** Converts to OKLCH and clamps lightness/chroma into the calm ambient band, hue preserved. */
export function toAmbient(rgb: RgbColor, options?: ToAmbientOptions): OklchColor {
  const oklch = rgbToOklch(rgb)
  const [lightnessMin, lightnessMax] = options?.lightness ?? DARK_LIGHTNESS_RANGE
  const maxChroma = options?.maxChroma ?? DEFAULT_MAX_CHROMA
  return {
    l: Math.min(lightnessMax, Math.max(lightnessMin, oklch.l)),
    c: Math.min(maxChroma, oklch.c),
    h: oklch.h,
  }
}

/** `oklch(L% C H)` or `oklch(L% C H / alpha)` when `alpha` is given. */
export function ambientCss(color: OklchColor, alpha?: number): string {
  const lightnessPct = `${(color.l * 100).toFixed(1)}%`
  const chroma = color.c.toFixed(4)
  const hue = color.h.toFixed(1)
  return alpha === undefined
    ? `oklch(${lightnessPct} ${chroma} ${hue})`
    : `oklch(${lightnessPct} ${chroma} ${hue} / ${alpha})`
}

const SLATE_NEUTRAL_LIGHTNESS = 0.5

/** Blends `color` toward a neutral, achromatic slate by `amount` (0 = unchanged, 1 = fully neutral). */
export function blendTowardSlate(color: OklchColor, amount: number): OklchColor {
  const clampedAmount = Math.min(1, Math.max(0, amount))
  return {
    l: color.l + (SLATE_NEUTRAL_LIGHTNESS - color.l) * clampedAmount,
    c: color.c * (1 - clampedAmount),
    h: color.h,
  }
}
