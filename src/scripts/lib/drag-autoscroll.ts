// Pure edge-scroll velocity math for drag-to-reorder lists.

export function edgeScrollVelocity(
  clientY: number,
  top: number,
  bottom: number,
  threshold: number,
  maxSpeed: number
): number {
  if (clientY < top + threshold) {
    const proximity = (top + threshold - clientY) / threshold
    return -Math.min(maxSpeed, maxSpeed * proximity)
  }
  if (clientY > bottom - threshold) {
    const proximity = (clientY - (bottom - threshold)) / threshold
    return Math.min(maxSpeed, maxSpeed * proximity)
  }
  return 0
}
