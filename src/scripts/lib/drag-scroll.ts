// Mouse drag-to-scroll for horizontal card strips. Touch keeps native panning.

const DRAG_THRESHOLD_PX = 6

export function dragScroll(node: HTMLElement): { destroy(): void } {
  let pointerId: number | null = null
  let startX = 0
  let startScrollLeft = 0
  let dragging = false

  function suppressNextClick() {
    function onClick(event: MouseEvent) {
      event.preventDefault()
      event.stopPropagation()
      node.removeEventListener("click", onClick, true)
    }
    node.addEventListener("click", onClick, true)
    setTimeout(() => node.removeEventListener("click", onClick, true), 0)
  }

  function endDrag() {
    if (!dragging) {
      pointerId = null
      return
    }
    dragging = false
    delete node.dataset.dragScrolling
    node.style.scrollSnapType = ""
    if (pointerId !== null && node.hasPointerCapture(pointerId)) {
      node.releasePointerCapture(pointerId)
    }
    pointerId = null
    suppressNextClick()
  }

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType !== "mouse" || event.button !== 0) return
    pointerId = event.pointerId
    startX = event.clientX
    startScrollLeft = node.scrollLeft
  }

  function onPointerMove(event: PointerEvent) {
    if (pointerId === null || event.pointerId !== pointerId) return
    // Button released outside before capture; pointerId persists, so disarm instead of phantom-dragging later.
    if ((event.buttons & 1) === 0) {
      endDrag()
      return
    }
    const deltaX = event.clientX - startX
    if (!dragging) {
      if (Math.abs(deltaX) < DRAG_THRESHOLD_PX) return
      dragging = true
      node.setPointerCapture(pointerId)
      node.dataset.dragScrolling = "true"
      node.style.scrollSnapType = "none"
    }
    event.preventDefault()
    node.scrollLeft = startScrollLeft - deltaX
  }

  function onPointerUp(event: PointerEvent) {
    if (pointerId === null || event.pointerId !== pointerId) return
    endDrag()
  }

  function onPointerCancel(event: PointerEvent) {
    if (pointerId === null || event.pointerId !== pointerId) return
    endDrag()
  }

  function onDragStart(event: DragEvent) {
    // Native link/image drag wins the race below our drag threshold, so suppress it for any armed press.
    if (pointerId !== null || dragging) event.preventDefault()
  }

  node.addEventListener("pointerdown", onPointerDown)
  node.addEventListener("pointermove", onPointerMove)
  node.addEventListener("pointerup", onPointerUp)
  node.addEventListener("pointercancel", onPointerCancel)
  node.addEventListener("dragstart", onDragStart)

  return {
    destroy() {
      node.removeEventListener("pointerdown", onPointerDown)
      node.removeEventListener("pointermove", onPointerMove)
      node.removeEventListener("pointerup", onPointerUp)
      node.removeEventListener("pointercancel", onPointerCancel)
      node.removeEventListener("dragstart", onDragStart)
    },
  }
}
