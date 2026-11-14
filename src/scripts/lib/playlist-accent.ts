// Applies the active playlist's accent override to data-accent, never writing xt_accent.
// Cached to xt_accent_active: Tauri entries live in plugin-store, so the cache is
// the pre-paint script's only synchronous signal.

import {
  ACCENT_PRESETS,
  ACCENT_EVENT,
  getAccent,
  resolveAccentForDisplay,
} from "@/scripts/lib/app-settings.js"
import { getActiveEntry } from "@/scripts/lib/creds.js"

const ACTIVE_ACCENT_CACHE_KEY = "xt_accent_active"

function writeActiveAccentCache(accent: string): void {
  try {
    if (accent) localStorage.setItem(ACTIVE_ACCENT_CACHE_KEY, accent)
    else localStorage.removeItem(ACTIVE_ACCENT_CACHE_KEY)
  } catch {
    // Private mode etc.: pre-paint just misses the cache next boot.
  }
}

/** Pure resolution: a valid per-playlist override wins, else the global accent. */
export function resolveEffectiveAccent(entryAccent: unknown, globalAccent: string): string {
  return typeof entryAccent === "string" && ACCENT_PRESETS.includes(entryAccent)
    ? entryAccent
    : globalAccent
}

/** Re-applies data-accent from the active playlist's override, else the global accent. */
export async function applyEffectiveAccent(): Promise<void> {
  const activeEntry = await getActiveEntry()
  const overrideAccent =
    typeof activeEntry?.accent === "string" && ACCENT_PRESETS.includes(activeEntry.accent)
      ? activeEntry.accent
      : ""
  const effectiveAccent = overrideAccent || resolveAccentForDisplay(getAccent())
  if (typeof document !== "undefined") {
    if (effectiveAccent === "fuchsia") document.documentElement.removeAttribute("data-accent")
    else document.documentElement.setAttribute("data-accent", effectiveAccent)
  }
  writeActiveAccentCache(overrideAccent)
}

/** Resolves the active accent to a plain "#rrggbb" hex, or "" if it can't be resolved. */
export function resolveAccentHex(): string {
  if (typeof document === "undefined") return ""
  try {
    const probe = document.createElement("span")
    probe.style.color = "var(--color-accent)"
    // The native player chrome is always dark, so it wants the dark swatch even in light theme.
    probe.style.colorScheme = "dark"
    const probeParent = document.body || document.documentElement
    probeParent.appendChild(probe)
    const computedColor = getComputedStyle(probe).color
    probeParent.removeChild(probe)

    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return ""
    ctx.fillStyle = computedColor
    ctx.fillRect(0, 0, 1, 1)
    const [red, green, blue] = ctx.getImageData(0, 0, 1, 1).data
    const toHexByte = (value: number) => value.toString(16).padStart(2, "0")
    return `#${toHexByte(red)}${toHexByte(green)}${toHexByte(blue)}`
  } catch {
    return ""
  }
}

/** Boots the override system: applies it once, then keeps it in sync. */
export function initPlaylistAccent(): void {
  applyEffectiveAccent()
  document.addEventListener("xt:active-changed", applyEffectiveAccent)
  document.addEventListener("xt:entries-updated", applyEffectiveAccent)
  document.addEventListener(ACCENT_EVENT, applyEffectiveAccent)
}
