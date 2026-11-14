// Batches D-pad key-repeat bursts into at most one DOM update per animation frame, while
// keeping the very first keydown of a burst synchronous so a fast Down-then-Enter can never
// activate the row that was focused before the Down was handled. Only pushes that arrive
// while a burst is already in flight (i.e. before the next frame runs) get batched; a burst
// ends once a whole frame passes with no push, so the next push starts a fresh one.

export interface KeyRepeatCoalescer {
  /** Adds `delta` to the pending, not-yet-applied total. Applies synchronously if this is
   * the first push of a new burst; otherwise batches until the next animation frame. */
  push(delta: number): void
  /** The pending delta not yet handed to the apply callback. */
  pending(): number
  /** Cancels any scheduled flush, drops the pending delta, and ends the current burst. */
  cancel(): void
  /** Applies any pending delta immediately instead of waiting for the next frame. */
  flush(): void
}

/** `apply` receives the sum of every batched `push()` since the last apply. */
export function createKeyRepeatCoalescer(apply: (delta: number) => void): KeyRepeatCoalescer {
  let pendingDelta = 0
  let burstActive = false
  let pushedSinceWatch = false

  function applyPending(): void {
    if (pendingDelta === 0) return
    const delta = pendingDelta
    pendingDelta = 0
    apply(delta)
  }

  // Watches one frame at a time; as long as a push lands before the watched frame fires,
  // the burst keeps going. Once a frame passes with no push, the burst ends.
  function scheduleWatch(): void {
    requestAnimationFrame(() => {
      applyPending()
      if (!pushedSinceWatch) {
        burstActive = false
        return
      }
      pushedSinceWatch = false
      scheduleWatch()
    })
  }

  return {
    push(delta: number): void {
      if (!burstActive) {
        burstActive = true
        pushedSinceWatch = false
        apply(delta)
        scheduleWatch()
        return
      }
      pushedSinceWatch = true
      pendingDelta += delta
    },
    pending(): number {
      return pendingDelta
    },
    cancel(): void {
      pendingDelta = 0
      burstActive = false
      pushedSinceWatch = false
    },
    flush(): void {
      pushedSinceWatch = false
      applyPending()
    },
  }
}
