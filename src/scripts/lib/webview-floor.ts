import { chromiumMajorFromUserAgent } from "@/scripts/lib/codec-hints"

// Mirrors astro.config.mjs vite.build.cssTarget
export const MIN_CHROMIUM_MAJOR = 111

export const parseChromiumMajor = chromiumMajorFromUserAgent

export function isBelowChromiumFloor(
  userAgent: string,
  min: number = MIN_CHROMIUM_MAJOR,
): boolean {
  const major = parseChromiumMajor(userAgent)
  if (major === null) return false
  return major < min
}
