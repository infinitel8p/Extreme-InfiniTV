// Canvas2D overlay that renders the splash comet as a streak of light along
// the mark's figure-8 orbit. The head is a hot white core with an accent-colored
// radial halo; behind it ~50 sampled points trail off via exponential alpha
// falloff and shrinking radius. All samples draw with additive blending
// (globalCompositeOperation = "lighter") so overlapping points sum into a
// luminous streak instead of reading as discrete dots.
//
// Path samples come from the SVG `<path>`'s native getPointAtLength(), which
// the engine precomputes and caches internally so per-frame sampling is
// cheap. Cleanup cancels rAF and disconnects the ResizeObserver - call it
// before removing the splash from the DOM.
//
// Bails to canvas display:none (no comet at all) when:
//   - prefers-reduced-motion is set
//   - data-perf-mode="on" (TV / Leanback)
//   - Canvas2D context unavailable

const CYCLE_MS = 6000
const TRAIL_SAMPLES = 32
const TRAIL_LENGTH_FRAC = 0.2
const PATH_CACHE_SAMPLES = 256
const VIEWBOX_MIN_X = 8
const VIEWBOX_MIN_Y = 58
const VIEWBOX_WIDTH = 224

const ACCENT_FALLBACK: [number, number, number] = [0.91, 0.5, 0.78]

function parseAccent(): [number, number, number] {
  try {
    const probe = document.createElement("span")
    probe.style.color = "var(--color-accent)"
    probe.style.display = "none"
    document.body.appendChild(probe)
    const resolved = getComputedStyle(probe).color
    probe.remove()
    if (!resolved) return ACCENT_FALLBACK

    const tmp = document.createElement("canvas")
    tmp.width = 1
    tmp.height = 1
    const tctx = tmp.getContext("2d")
    if (!tctx) return ACCENT_FALLBACK
    tctx.fillStyle = resolved
    tctx.fillRect(0, 0, 1, 1)
    const data = tctx.getImageData(0, 0, 1, 1).data
    return [data[0] / 255, data[1] / 255, data[2] / 255]
  } catch {
    return ACCENT_FALLBACK
  }
}

export function setupSplashComet(splash: HTMLElement): () => void {
  const canvas = splash.querySelector(".xt-app-splash__comet") as HTMLCanvasElement | null
  const pathEl = splash.querySelector("#xt-app-splash-path") as SVGPathElement | null
  if (!canvas || !pathEl) return () => { }

  const reduced =
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.getAttribute("data-perf-mode") === "on"
  if (reduced) {
    canvas.style.display = "none"
    return () => { }
  }

  const ctx = canvas.getContext("2d", { alpha: true })
  if (!ctx) {
    canvas.style.display = "none"
    return () => { }
  }

  let pathLen = 0
  try { pathLen = pathEl.getTotalLength() } catch { }
  if (pathLen <= 0) {
    canvas.style.display = "none"
    return () => { }
  }

  const accent = parseAccent()
  const ar = Math.round(accent[0] * 255)
  const ag = Math.round(accent[1] * 255)
  const ab = Math.round(accent[2] * 255)
  const accentStr = `${ar}, ${ag}, ${ab}`

  // Pre-sample the SVG path in user units once
  const pathXs = new Float32Array(PATH_CACHE_SAMPLES)
  const pathYs = new Float32Array(PATH_CACHE_SAMPLES)
  for (let cacheIdx = 0; cacheIdx < PATH_CACHE_SAMPLES; cacheIdx++) {
    const point = pathEl.getPointAtLength((cacheIdx / PATH_CACHE_SAMPLES) * pathLen)
    pathXs[cacheIdx] = point.x
    pathYs[cacheIdx] = point.y
  }
  const samplePath = (dist: number): { x: number; y: number } => {
    let normalized = dist / pathLen
    normalized = normalized - Math.floor(normalized)
    const floatIdx = normalized * PATH_CACHE_SAMPLES
    const lowIdx = Math.floor(floatIdx)
    const highIdx = (lowIdx + 1) % PATH_CACHE_SAMPLES
    const frac = floatIdx - lowIdx
    return {
      x: pathXs[lowIdx] + (pathXs[highIdx] - pathXs[lowIdx]) * frac,
      y: pathYs[lowIdx] + (pathYs[highIdx] - pathYs[lowIdx]) * frac,
    }
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2)

  // Pre-render the head halo and core as offscreen sprites
  const haloR = 16 * dpr
  const coreR = 3.4 * dpr
  const buildSprite = (
    radius: number,
    stops: Array<[number, string]>,
  ): HTMLCanvasElement => {
    const sprite = document.createElement("canvas")
    const side = Math.ceil(radius * 2)
    sprite.width = side
    sprite.height = side
    const spriteCtx = sprite.getContext("2d")
    if (!spriteCtx) return sprite
    const gradient = spriteCtx.createRadialGradient(radius, radius, 0, radius, radius, radius)
    for (const [stop, color] of stops) gradient.addColorStop(stop, color)
    spriteCtx.fillStyle = gradient
    spriteCtx.fillRect(0, 0, side, side)
    return sprite
  }
  const haloSprite = buildSprite(haloR, [
    [0, `rgba(${accentStr}, 0.85)`],
    [0.35, `rgba(${accentStr}, 0.30)`],
    [1, `rgba(${accentStr}, 0)`],
  ])
  const coreSprite = buildSprite(coreR, [
    [0, "rgba(255, 255, 255, 1)"],
    [0.45, "rgba(255, 255, 255, 0.7)"],
    [1, `rgba(${accentStr}, 0)`],
  ])
  // SVG user units (viewBox 8 58 224 124) -> canvas pixels, plus an offset
  // for the SVG's position inside the (larger) canvas. The mark-wrap pads
  // the canvas out past the SVG so the comet's halo can bloom freely.
  let userToPx = 1
  let offsetX = 0
  let offsetY = 0

  const wrap = canvas.parentElement
  const resize = () => {
    const canvasRect = canvas.getBoundingClientRect()
    const cssW = canvasRect.width || 1
    const cssH = canvasRect.height || 1
    canvas.width = Math.max(1, Math.round(cssW * dpr))
    canvas.height = Math.max(1, Math.round(cssH * dpr))
    if (wrap) {
      const wrapRect = wrap.getBoundingClientRect()
      const style = getComputedStyle(wrap)
      const padLeft = parseFloat(style.paddingLeft) || 0
      const padTop = parseFloat(style.paddingTop) || 0
      const padRight = parseFloat(style.paddingRight) || 0
      const contentW = Math.max(1, wrapRect.width - padLeft - padRight)
      offsetX = (wrapRect.left + padLeft - canvasRect.left) * dpr
      offsetY = (wrapRect.top + padTop - canvasRect.top) * dpr
      userToPx = (contentW / VIEWBOX_WIDTH) * dpr
    } else {
      offsetX = 0
      offsetY = 0
      userToPx = (cssW / VIEWBOX_WIDTH) * dpr
    }
  }
  resize()

  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(resize)
    ro.observe(canvas)
  } else {
    window.addEventListener("resize", resize)
  }

  let rafId = 0
  let running = true
  const startTime = performance.now()
  // Cap at 30 FPS
  const FRAME_MIN_MS = 1000 / 30
  let lastDrawTime = 0

  const draw = () => {
    if (!running) return
    const now = performance.now()
    if (now - lastDrawTime < FRAME_MIN_MS) {
      rafId = requestAnimationFrame(draw)
      return
    }
    lastDrawTime = now
    const elapsed = (now - startTime) % CYCLE_MS
    // Reverse travel direction: head runs the path backwards over time.
    const headDist = pathLen - (elapsed / CYCLE_MS) * pathLen

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.globalCompositeOperation = "lighter"

    // Trail (drawn tail-first so the head sample is the last/topmost layer).
    for (let trailIdx = TRAIL_SAMPLES; trailIdx >= 1; trailIdx--) {
      const tailT = trailIdx / TRAIL_SAMPLES // 0 at head, 1 at tail
      const dist = headDist + tailT * TRAIL_LENGTH_FRAC * pathLen
      const pt = samplePath(dist)
      const x = offsetX + (pt.x - VIEWBOX_MIN_X) * userToPx
      const y = offsetY + (pt.y - VIEWBOX_MIN_Y) * userToPx

      const alpha = Math.pow(1 - tailT, 2.2) * 0.55
      const radius = (2.4 - tailT * 2.0) * dpr
      if (radius < 0.3) continue

      ctx.fillStyle = `rgba(${accentStr}, ${alpha})`
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fill()
    }

    // Head: accent halo + hot white core, blitted from pre-rendered sprites.
    const headPt = samplePath(headDist)
    const hx = offsetX + (headPt.x - VIEWBOX_MIN_X) * userToPx
    const hy = offsetY + (headPt.y - VIEWBOX_MIN_Y) * userToPx
    ctx.drawImage(haloSprite, hx - haloR, hy - haloR)
    ctx.drawImage(coreSprite, hx - coreR, hy - coreR)

    rafId = requestAnimationFrame(draw)
  }
  draw()

  return () => {
    running = false
    if (rafId) cancelAnimationFrame(rafId)
    if (ro) ro.disconnect()
    else window.removeEventListener("resize", resize)
  }
}
