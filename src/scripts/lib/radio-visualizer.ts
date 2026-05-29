// Single-line oscilloscope for radio (audio-only) streams.

import { log } from "@/scripts/lib/log.js"

interface VideoGraph {
  ctx: AudioContext
  source: MediaElementAudioSourceNode
  analyser: AnalyserNode
}

const graphs = new WeakMap<HTMLVideoElement, VideoGraph>()

function reducedMotion(): boolean {
  if (typeof matchMedia !== "function") return false
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

function perfMode(): boolean {
  if (typeof document === "undefined") return false
  return document.documentElement.getAttribute("data-perf-mode") === "on"
}

function resolveAccent(canvas: HTMLCanvasElement): string {
  try {
    const styles = getComputedStyle(canvas)
    const accent = styles.getPropertyValue("--color-accent").trim()
    if (accent) return accent
  } catch {}
  return "oklch(0.78 0.15 330)"
}

function buildGraph(videoEl: HTMLVideoElement): VideoGraph | null {
  const cached = graphs.get(videoEl)
  if (cached) return cached
  const Ctor =
    typeof window !== "undefined"
      ? (window.AudioContext || (window as any).webkitAudioContext)
      : null
  if (!Ctor) return null
  try {
    const ctx = new Ctor() as AudioContext
    const source = ctx.createMediaElementSource(videoEl)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.78
    source.connect(analyser)
    source.connect(ctx.destination)
    const graph: VideoGraph = { ctx, source, analyser }
    graphs.set(videoEl, graph)
    return graph
  } catch (err) {
    log.warn("[xt:radio-viz] Web Audio init failed:", err)
    return null
  }
}

export interface RadioVisualizerHandle {
  detach(): void
}

export function attachRadioVisualizer(
  container: HTMLElement,
  videoEl: HTMLVideoElement,
): RadioVisualizerHandle {
  const canvas = document.createElement("canvas")
  canvas.dataset.radioVisualizer = ""
  canvas.setAttribute("aria-hidden", "true")
  canvas.className = "radio-visualizer"
  container.appendChild(canvas)

  const ctx2d = canvas.getContext("2d")
  let raf = 0
  let disposed = false
  let lastDraw = 0
  const targetFps = 30
  let smoothedEnergy = 0
  const MOUNT_FADE_MS = 400
  let mountStart = 0

  const graph = buildGraph(videoEl)
  const dataArray = graph
    ? new Uint8Array(graph.analyser.fftSize)
    : new Uint8Array(0)

  const resume = () => {
    if (graph && graph.ctx.state === "suspended") {
      graph.ctx.resume().catch(() => {})
    }
  }
  videoEl.addEventListener("playing", resume)
  videoEl.addEventListener("play", resume)

  const resize = () => {
    if (disposed) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.floor(rect.width * dpr))
    canvas.height = Math.max(1, Math.floor(rect.height * dpr))
    if (ctx2d) ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  let resizeObserver: ResizeObserver | null = null
  try {
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)
  } catch {
    window.addEventListener("resize", resize)
  }
  resize()

  let currentAccent = resolveAccent(canvas)
  const refreshAccent = () => {
    if (disposed) return
    currentAccent = resolveAccent(canvas)
  }

  let themeObserver: MutationObserver | null = null
  try {
    themeObserver = new MutationObserver(refreshAccent)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    })
  } catch {}

  let schemeMql: MediaQueryList | null = null
  if (typeof matchMedia === "function") {
    try {
      schemeMql = matchMedia("(prefers-color-scheme: dark)")
      schemeMql.addEventListener("change", refreshAccent)
    } catch {
      schemeMql = null
    }
  }

  const staticLine = reducedMotion() || perfMode() || !graph

  const allowBreath = !reducedMotion() && !perfMode()
  const BREATH_DIVISOR = 575

  const setEnergy = (next: number) => {
    smoothedEnergy = next
    container.style.setProperty("--radio-viz-energy", next.toFixed(3))
  }
  setEnergy(0)

  const draw = (timestamp: number) => {
    if (disposed) return
    if (timestamp - lastDraw < 1000 / targetFps) {
      raf = requestAnimationFrame(draw)
      return
    }
    const dt = lastDraw === 0 ? 1 / targetFps : (timestamp - lastDraw) / 1000
    lastDraw = timestamp
    if (!ctx2d) {
      raf = requestAnimationFrame(draw)
      return
    }
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width === 0 || height === 0) {
      raf = requestAnimationFrame(draw)
      return
    }
    ctx2d.clearRect(0, 0, width, height)
    const accent = currentAccent
    const midY = height / 2

    ctx2d.lineCap = "round"
    ctx2d.lineJoin = "round"
    ctx2d.strokeStyle = accent
    ctx2d.fillStyle = accent

    if (mountStart === 0) mountStart = timestamp
    const mountFade = Math.min(1, (timestamp - mountStart) / MOUNT_FADE_MS)

    const isIdle = staticLine || videoEl.paused || videoEl.muted

    if (isIdle) {
      setEnergy(smoothedEnergy * 0.85)

      const breath = allowBreath
        ? 0.32 + 0.13 * Math.sin(timestamp / BREATH_DIVISOR)
        : 0.32

      ctx2d.globalAlpha = breath * mountFade
      ctx2d.lineWidth = 1.25
      ctx2d.beginPath()
      ctx2d.moveTo(2, midY)
      ctx2d.lineTo(width - 2, midY)
      ctx2d.stroke()

      ctx2d.globalAlpha = Math.min(1, breath * 1.4) * mountFade
      ctx2d.beginPath()
      ctx2d.arc(2, midY, 1.4, 0, Math.PI * 2)
      ctx2d.arc(width - 2, midY, 1.4, 0, Math.PI * 2)
      ctx2d.fill()

      ctx2d.globalAlpha = 1
      raf = requestAnimationFrame(draw)
      return
    }

    graph!.analyser.getByteTimeDomainData(dataArray)

    const samples = dataArray.length
    const stepX = width / (samples - 1)
    const amplitude = height * 0.42

    let sumSq = 0
    for (let i = 0; i < samples; i++) {
      const value = (dataArray[i] - 128) / 128
      sumSq += value * value
    }
    const rms = Math.sqrt(sumSq / samples)
    const target = Math.min(1, rms * 2.4)
    const tau = target > smoothedEnergy ? 0.08 : 0.22
    const alpha = 1 - Math.exp(-dt / tau)
    const nextEnergy = smoothedEnergy + (target - smoothedEnergy) * alpha
    setEnergy(nextEnergy)

    // Soft underline so the line has presence even at low signal.
    ctx2d.globalAlpha = 0.18 * mountFade
    ctx2d.lineWidth = 1
    ctx2d.beginPath()
    ctx2d.moveTo(2, midY)
    ctx2d.lineTo(width - 2, midY)
    ctx2d.stroke()

    ctx2d.globalAlpha = 0.92 * mountFade
    ctx2d.lineWidth = 1.3 + nextEnergy * 0.9
    ctx2d.beginPath()
    for (let i = 0; i < samples; i++) {
      const value = (dataArray[i] - 128) / 128
      const x = i * stepX
      const y = midY + value * amplitude
      if (i === 0) ctx2d.moveTo(x, y)
      else ctx2d.lineTo(x, y)
    }
    ctx2d.stroke()

    const firstValue = (dataArray[0] - 128) / 128
    const lastValue = (dataArray[samples - 1] - 128) / 128
    ctx2d.globalAlpha = mountFade
    ctx2d.beginPath()
    ctx2d.arc(0, midY + firstValue * amplitude, 1.6, 0, Math.PI * 2)
    ctx2d.arc(width, midY + lastValue * amplitude, 1.6, 0, Math.PI * 2)
    ctx2d.fill()

    ctx2d.globalAlpha = 1
    raf = requestAnimationFrame(draw)
  }
  raf = requestAnimationFrame(draw)

  return {
    detach() {
      if (disposed) return
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      videoEl.removeEventListener("playing", resume)
      videoEl.removeEventListener("play", resume)
      if (resizeObserver) {
        try { resizeObserver.disconnect() } catch {}
      } else {
        window.removeEventListener("resize", resize)
      }
      if (themeObserver) {
        try { themeObserver.disconnect() } catch {}
      }
      if (schemeMql) {
        try { schemeMql.removeEventListener("change", refreshAccent) } catch {}
      }
      try { canvas.remove() } catch {}
      // Leave the AudioContext + source live: re-creating
      // createMediaElementSource on the same element throws, and the audio
      // is still routed to ctx.destination so playback keeps working.
    },
  }
}
