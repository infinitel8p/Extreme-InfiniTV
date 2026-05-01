// Discord Rich Presence wrapper
import {
  isDiscordEnabledForPlaylist,
  getDiscordClientId,
} from "@/scripts/lib/app-settings.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)

const isDesktop = (() => {
  if (!isTauri) return false
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent || ""
  if (/Android/i.test(ua)) return false
  if (/iPhone|iPad|iPod/i.test(ua)) return false
  return true
})()

let invokePromise = null
async function getInvoke() {
  if (!isDesktop) return null
  if (!invokePromise) {
    invokePromise = import("@tauri-apps/api/core")
      .then((mod) => mod.invoke)
      .catch((error) => {
        console.warn("[xt:discord] tauri core import failed:", error)
        return null
      })
  }
  return invokePromise
}

const PROMO_BUTTONS = [
  { label: "Get Extreme InfiniTV", url: "https://github.com/infinitel8p/xtream/releases/latest" },
  { label: "View on GitHub", url: "https://github.com/infinitel8p/xtream" },
]

let lastSignature = ""
let lastFailureLogged = false

/**
 * Push a "now watching" presence to Discord. Silently no-ops when:
 *   - the active playlist hasn't opted in
 *   - no Discord Client ID is configured
 *   - we're not on desktop
 *
 * @param {Object} payload
 * @param {string} payload.playlistId
 * @param {string} payload.details   - main line, e.g. "Watching CNN"
 * @param {string} [payload.state]   - second line, e.g. "Live · The Lead"
 * @param {string} [payload.largeImage]
 * @param {string} [payload.largeText]
 * @param {string} [payload.smallImage]
 * @param {string} [payload.smallText]
 * @param {number} [payload.startTimestamp] - epoch ms
 */
export async function setRichPresence(payload) {
  if (!isDesktop || !payload?.playlistId) return
  if (!isDiscordEnabledForPlaylist(payload.playlistId)) return
  const clientId = getDiscordClientId()
  if (!clientId) return

  const buttons = Array.isArray(payload.buttons) && payload.buttons.length
    ? payload.buttons.slice(0, 2)
    : PROMO_BUTTONS

  const signature = JSON.stringify({
    cid: clientId,
    d: payload.details || "",
    s: payload.state || "",
    li: payload.largeImage || "",
    lt: payload.largeText || "",
    si: payload.smallImage || "",
    st: payload.smallText || "",
    ts: payload.startTimestamp || 0,
    btn: buttons,
  })
  if (signature === lastSignature) return
  lastSignature = signature

  const invoke = await getInvoke()
  if (!invoke) return

  try {
    await invoke("discord_set_activity", {
      clientId,
      details: payload.details || null,
      stateText: payload.state || null,
      largeImage: payload.largeImage || null,
      largeText: payload.largeText || null,
      smallImage: payload.smallImage || null,
      smallText: payload.smallText || null,
      startTimestamp: payload.startTimestamp
        ? Math.floor(payload.startTimestamp / 1000)
        : null,
      buttons,
    })
    lastFailureLogged = false
  } catch (error) {
    if (!lastFailureLogged) {
      console.warn("[xt:discord] set_activity failed:", error)
      lastFailureLogged = true
    }
    lastSignature = ""
  }
}

export async function clearRichPresence() {
  if (!isDesktop) return
  const invoke = await getInvoke()
  if (!invoke) return
  try {
    await invoke("discord_clear")
  } catch (error) {
    console.debug("[xt:discord] clear failed:", error)
  } finally {
    lastSignature = ""
  }
}

export async function disconnectRichPresence() {
  if (!isDesktop) return
  const invoke = await getInvoke()
  if (!invoke) return
  try {
    await invoke("discord_disconnect")
  } catch (error) {
    console.debug("[xt:discord] disconnect failed:", error)
  } finally {
    lastSignature = ""
  }
}

export const discordRpcSupported = isDesktop
