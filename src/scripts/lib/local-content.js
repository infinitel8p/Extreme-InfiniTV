// IndexedDB-backed storage for local-m3u playlist text.
//
// Local-m3u entries can be megabytes of text - well past the ~5 MiB
// localStorage quota that the main `xt_playlists` blob lives under.
// Keeping the text in its own IDB store means the entries blob stays
// tiny (metadata only) and large playlists don't blow up the
// localStorage mirror in creds.js.

import { log } from "@/scripts/lib/log.js"

const DB_NAME = "xt_local_content"
const DB_VERSION = 1
const STORE = "entries"
export const LOCAL_CONTENT_MAX_BYTES = 25 * 1024 * 1024 // 25 MiB

/** UTF-8 byte size of a string; the cap is a byte budget, not a char count. */
export function utf8ByteLength(text) {
  const value = text || ""
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length
  // Fallback for environments without TextEncoder: count surrogate-aware bytes.
  let bytes = 0
  for (const codePointStr of value) {
    const codePoint = codePointStr.codePointAt(0)
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"))
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error("IDB blocked"))
  })
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

/**
 * Persist the M3U text for one playlist entry. Rejects payloads larger
 * than LOCAL_CONTENT_MAX_BYTES so callers that bypass the login.astro
 * pre-check can't still wedge a multi-GB playlist into IDB.
 *
 * @param {string} entryId
 * @param {string} text
 * @returns {Promise<boolean>} true if persisted, false if rejected.
 */
export async function setLocalContent(entryId, text) {
  if (!entryId) return false
  const value = text || ""
  const byteSize = utf8ByteLength(value)
  if (byteSize > LOCAL_CONTENT_MAX_BYTES) {
    log.warn(
      "[xt:local-content] setLocalContent rejected oversize payload:",
      byteSize,
      ">",
      LOCAL_CONTENT_MAX_BYTES
    )
    return false
  }
  try {
    const db = await openDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(value, entryId)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    return true
  } catch (e) {
    log.error("[xt:local-content] setLocalContent failed:", e)
    return false
  }
}

/**
 * Read the M3U text for one playlist entry. Returns "" if the entry has
 * no stored content, or null when IDB itself is unavailable / threw.
 *
 * @param {string} entryId
 * @returns {Promise<string|null>}
 */
export async function getLocalContent(entryId) {
  if (!entryId) return ""
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      const req = tx.objectStore(STORE).get(entryId)
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : "")
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    log.warn("[xt:local-content] getLocalContent failed:", e)
    return null
  }
}

/**
 * Drop the M3U text for one playlist entry.
 * @param {string} entryId
 */
export async function deleteLocalContent(entryId) {
  if (!entryId) return
  try {
    const db = await openDB()
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).delete(entryId)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
    })
  } catch (e) {
    log.warn("[xt:local-content] deleteLocalContent failed:", e)
  }
}
