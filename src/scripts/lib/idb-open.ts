// Shared timed IndexedDB open: races a connection against a timeout so a
// wedged/blocked open degrades to null instead of hanging every caller.

import { log } from "@/scripts/lib/log.js"

const DEFAULT_TIMEOUT_MS = 3000
// Hard ceiling on how long a stuck upgrade transaction can re-arm the timeout.
const UPGRADE_GRACE_MS = 30000

export interface TimedIdbConfig {
  name: string
  version: number
  logTag: string
  upgrade: (db: IDBDatabase, event: IDBVersionChangeEvent) => void
}

export interface TimedIdbOpener {
  /** Raced against `timeoutMs` (default 3s); resolves null on timeout/failure. */
  open(timeoutMs?: number): Promise<IDBDatabase | null>
  /** Un-raced: awaits the real open however long it takes. Use for writes that must not be dropped. */
  openUnraced(): Promise<IDBDatabase | null>
}

interface OpenerState {
  dbPromise: Promise<IDBDatabase | null> | null
  openPromise: Promise<IDBDatabase> | null
  upgrading: boolean
}

/** One opener per (name, version) - keeps a single connection cache shared across timed and un-raced callers. */
export function createTimedIdbOpener(config: TimedIdbConfig): TimedIdbOpener {
  const state: OpenerState = { dbPromise: null, openPromise: null, upgrading: false }

  function startOpen(): Promise<IDBDatabase> {
    if (state.openPromise) return state.openPromise
    const open = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(config.name, config.version)
      req.onupgradeneeded = (event) => {
        state.upgrading = true
        config.upgrade(req.result, event)
      }
      req.onsuccess = () => {
        state.upgrading = false
        const db = req.result
        // Another document upgrading the schema needs this connection closed.
        db.onversionchange = () => {
          try { db.close() } catch {}
          state.dbPromise = null
          state.openPromise = null
        }
        resolve(db)
      }
      req.onerror = () => {
        state.upgrading = false
        reject(req.error)
      }
      // Per spec `blocked` doesn't abort the request; it still resolves later.
      req.onblocked = () => {
        log.warn(`[${config.logTag}] open blocked by another connection, waiting`)
      }
    })
    state.openPromise = open
    open.then(undefined, () => {
      if (state.openPromise === open) state.openPromise = null
    })
    return open
  }

  function open(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<IDBDatabase | null> {
    if (state.dbPromise) return state.dbPromise
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("IndexedDB unavailable"))
    }
    const rawOpen = startOpen()
    let settled = false
    rawOpen.then(
      () => { settled = true },
      () => { settled = true }
    )
    let graced = false
    const openStartedAt = Date.now()
    const raced: Promise<IDBDatabase | null> = Promise.race([
      rawOpen,
      new Promise<null>((resolve) => {
        const fire = (): void => {
          if (settled) return
          if (state.upgrading && Date.now() - openStartedAt < UPGRADE_GRACE_MS) {
            setTimeout(fire, timeoutMs)
            return
          }
          // A stall can delay this timer past a connection that already resolved
          // in the same event-loop turn; give it one more tick before degrading.
          if (!graced) {
            graced = true
            setTimeout(fire, 0)
            return
          }
          log.warn(`[${config.logTag}] IDB open timed out, disabled for this page`)
          resolve(null)
        }
        setTimeout(fire, timeoutMs)
      }),
    ])
    rawOpen.then(
      (db) => {
        if (state.dbPromise === raced) state.dbPromise = Promise.resolve(db)
      },
      () => {
        if (state.dbPromise === raced) state.dbPromise = null
      }
    )
    state.dbPromise = raced
    return raced
  }

  function openUnraced(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === "undefined") return Promise.resolve(null)
    return startOpen().catch(() => null)
  }

  return { open, openUnraced }
}
