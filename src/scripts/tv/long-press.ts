// Shared D-pad Enter-hold + touch pointer-hold long-press detection for TV
// card grids, extracted from live.ts's channel-row action sheet trigger.

export interface LongPressOptions<T> {
  container: HTMLElement
  targetSelector: string
  resolveTarget: (row: HTMLElement) => T | null
  onActivate: (target: T) => void
  onLongPress: (target: T) => void
  holdMs?: number
  moveThresholdPx?: number
}

export interface LongPressHandle {
  destroy(): void
}

const DEFAULT_HOLD_MS = 650
const DEFAULT_MOVE_THRESHOLD_PX = 8

/** Timer-based rather than OS key-repeat, which varies by device. */
export function attachLongPress<T>(options: LongPressOptions<T>): LongPressHandle {
  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS
  const moveThreshold = options.moveThresholdPx ?? DEFAULT_MOVE_THRESHOLD_PX

  let timer: ReturnType<typeof setTimeout> | null = null
  let keyTarget: T | null = null
  let keyTriggered = false
  let pointerTarget: T | null = null
  let pointerTriggered = false
  let pointerStartX = 0
  let pointerStartY = 0

  function clearTimer(): void {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function closestTarget(element: HTMLElement | null): T | null {
    const row = element?.closest<HTMLElement>(options.targetSelector)
    return row ? options.resolveTarget(row) : null
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter") return
    const target = closestTarget(event.target as HTMLElement | null)
    if (!target) return
    event.preventDefault()
    if (event.repeat) return
    keyTarget = target
    keyTriggered = false
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      keyTriggered = true
      options.onLongPress(target)
    }, holdMs)
  }

  function onKeyup(event: KeyboardEvent): void {
    if (event.key !== "Enter") return
    const target = keyTarget
    const triggered = keyTriggered
    clearTimer()
    keyTarget = null
    keyTriggered = false
    if (!target) return
    event.preventDefault()
    if (!triggered) options.onActivate(target)
  }

  function onPointerDown(event: PointerEvent): void {
    const target = closestTarget(event.target as HTMLElement | null)
    if (!target) return
    pointerTarget = target
    pointerTriggered = false
    pointerStartX = event.clientX
    pointerStartY = event.clientY
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      pointerTriggered = true
      options.onLongPress(target)
    }, holdMs)
  }

  function onPointerMove(event: PointerEvent): void {
    if (timer == null || !pointerTarget) return
    if (Math.abs(event.clientX - pointerStartX) > moveThreshold || Math.abs(event.clientY - pointerStartY) > moveThreshold) {
      clearTimer()
      pointerTarget = null
    }
  }

  function onPointerEnd(): void {
    clearTimer()
    pointerTarget = null
  }

  // A real tap fires pointerup then click; a long-press already opened the
  // sheet, so this swallows the trailing click instead of also activating.
  // preventDefault covers anchor targets, whose native click would otherwise navigate too.
  function onClick(event: MouseEvent): void {
    if (pointerTriggered) {
      pointerTriggered = false
      event.preventDefault()
      return
    }
    const target = closestTarget(event.target as HTMLElement | null)
    if (!target) return
    event.preventDefault()
    options.onActivate(target)
  }

  options.container.addEventListener("keydown", onKeydown)
  options.container.addEventListener("keyup", onKeyup)
  options.container.addEventListener("pointerdown", onPointerDown)
  options.container.addEventListener("pointermove", onPointerMove)
  options.container.addEventListener("pointerup", onPointerEnd)
  options.container.addEventListener("pointercancel", onPointerEnd)
  options.container.addEventListener("click", onClick)

  return {
    destroy() {
      clearTimer()
      options.container.removeEventListener("keydown", onKeydown)
      options.container.removeEventListener("keyup", onKeyup)
      options.container.removeEventListener("pointerdown", onPointerDown)
      options.container.removeEventListener("pointermove", onPointerMove)
      options.container.removeEventListener("pointerup", onPointerEnd)
      options.container.removeEventListener("pointercancel", onPointerEnd)
      options.container.removeEventListener("click", onClick)
    },
  }
}
