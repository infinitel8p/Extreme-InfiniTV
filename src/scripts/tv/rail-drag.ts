// Pure math backing keepFocusedInView's mouse drag-to-scroll on x-axis TV rails.

export const DRAG_START_THRESHOLD_PX = 6

/** Clamps a drag-in-progress track shift to the same [-maxShiftPx, 0] range `position()` uses. */
export function clampDragShift(startShiftPx: number, deltaX: number, maxShiftPx: number): number {
  const clamped = Math.min(0, Math.max(-maxShiftPx, startShiftPx + deltaX))
  return clamped || 0
}

/** Index of the card nearest the rail's left anchor once a drag ends at `shiftPx`. */
export function pickAnchorIndex(cardOffsetsPx: number[], shiftPx: number, anchorOffsetPx: number): number {
  if (cardOffsetsPx.length === 0) return -1
  const targetOffsetPx = -shiftPx + anchorOffsetPx
  let closestIndex = 0
  let closestDistancePx = Infinity
  cardOffsetsPx.forEach((cardOffsetPx, index) => {
    const distancePx = Math.abs(cardOffsetPx - targetOffsetPx)
    if (distancePx < closestDistancePx) {
      closestDistancePx = distancePx
      closestIndex = index
    }
  })
  return closestIndex
}
