import { describe, expect, it, vi } from "vitest"
import {
  fallbackEngineFor,
  playWithFallback,
  selectEngine,
  type EngineRegistry,
} from "../src/scripts/receiver/engine-select"
import type { CastDescriptorV1 } from "../src/scripts/lib/tv-cast-descriptor"
import type { ReceiverEngine } from "../src/scripts/receiver/engines"

function stubEngine(playResult = true): ReceiverEngine {
  return {
    play: vi.fn(async () => playResult),
    control: vi.fn(),
    setVolume: vi.fn(),
    teardown: vi.fn(),
  }
}

function descriptor(overrides: Partial<CastDescriptorV1> = {}): CastDescriptorV1 {
  return {
    v: 1,
    src: "http://tv.example/live/user/pass/1.m3u8",
    mime: "application/x-mpegURL",
    isLive: true,
    title: "Channel",
    ...overrides,
  } as CastDescriptorV1
}

describe("selectEngine", () => {
  it("falls back to embedded when no native engine is registered", () => {
    const registry: EngineRegistry = { embedded: stubEngine() }
    expect(selectEngine(registry, descriptor(), "auto")).toBe(registry.embedded)
  })

  it("always picks native for an RTSP source, regardless of preference", () => {
    const registry: EngineRegistry = { embedded: stubEngine(), native: stubEngine() }
    const rtspDescriptor = descriptor({ src: "rtsp://tv.example/stream" })
    expect(selectEngine(registry, rtspDescriptor, "embedded")).toBe(registry.native)
  })

  it("honours an explicit embedded preference", () => {
    const registry: EngineRegistry = { embedded: stubEngine(), native: stubEngine() }
    expect(selectEngine(registry, descriptor(), "embedded")).toBe(registry.embedded)
  })

  it("honours an explicit native preference", () => {
    const registry: EngineRegistry = { embedded: stubEngine(), native: stubEngine() }
    expect(selectEngine(registry, descriptor(), "native")).toBe(registry.native)
  })

  it("picks embedded for DRM under auto preference", () => {
    const registry: EngineRegistry = { embedded: stubEngine(), native: stubEngine() }
    const drmDescriptor = descriptor({ drm: { drmScheme: "clearkey" } })
    expect(selectEngine(registry, drmDescriptor, "auto")).toBe(registry.embedded)
  })

  it("picks embedded when a timeline offset is set under auto preference", () => {
    const registry: EngineRegistry = { embedded: stubEngine(), native: stubEngine() }
    const offsetDescriptor = descriptor({ isLive: false, timelineOffsetSeconds: 120 })
    expect(selectEngine(registry, offsetDescriptor, "auto")).toBe(registry.embedded)
  })

  it("defaults to native under auto preference otherwise", () => {
    const registry: EngineRegistry = { embedded: stubEngine(), native: stubEngine() }
    expect(selectEngine(registry, descriptor(), "auto")).toBe(registry.native)
  })
})

describe("fallbackEngineFor", () => {
  it("returns embedded when the failed engine was native and the source isn't RTSP", () => {
    const registry: EngineRegistry = { embedded: stubEngine(), native: stubEngine() }
    expect(fallbackEngineFor(registry, registry.native!, descriptor())).toBe(registry.embedded)
  })

  it("returns null when the failed engine was native but the source is RTSP", () => {
    const registry: EngineRegistry = { embedded: stubEngine(), native: stubEngine() }
    const rtspDescriptor = descriptor({ src: "rtsp://tv.example/stream" })
    expect(fallbackEngineFor(registry, registry.native!, rtspDescriptor)).toBeNull()
  })

  it("returns null when the failed engine was embedded", () => {
    const registry: EngineRegistry = { embedded: stubEngine(), native: stubEngine() }
    expect(fallbackEngineFor(registry, registry.embedded, descriptor())).toBeNull()
  })
})

describe("playWithFallback", () => {
  it("falls back to embedded when native fails to start, and reports the fallback", async () => {
    const nativeEngine = stubEngine(false)
    const embeddedEngine = stubEngine(true)
    const registry: EngineRegistry = { embedded: embeddedEngine, native: nativeEngine }
    const onFallback = vi.fn()
    const start = vi.fn((engine: ReceiverEngine, castDescriptor: CastDescriptorV1) => engine.play(castDescriptor))

    const result = await playWithFallback(registry, descriptor(), { preference: "auto", start, onFallback })

    expect(result).toEqual({ engine: embeddedEngine, started: true })
    expect(onFallback).toHaveBeenCalledWith(nativeEngine, embeddedEngine)
    expect(nativeEngine.play).toHaveBeenCalledTimes(1)
    expect(embeddedEngine.play).toHaveBeenCalledTimes(1)
  })

  it("does not fall back when native starts fine", async () => {
    const nativeEngine = stubEngine(true)
    const embeddedEngine = stubEngine(true)
    const registry: EngineRegistry = { embedded: embeddedEngine, native: nativeEngine }
    const onFallback = vi.fn()
    const start = vi.fn((engine: ReceiverEngine, castDescriptor: CastDescriptorV1) => engine.play(castDescriptor))

    const result = await playWithFallback(registry, descriptor(), { preference: "auto", start, onFallback })

    expect(result).toEqual({ engine: nativeEngine, started: true })
    expect(onFallback).not.toHaveBeenCalled()
    expect(embeddedEngine.play).not.toHaveBeenCalled()
  })

  it("does not fall back when the failed native engine was chosen for an RTSP source", async () => {
    const nativeEngine = stubEngine(false)
    const embeddedEngine = stubEngine(true)
    const registry: EngineRegistry = { embedded: embeddedEngine, native: nativeEngine }
    const onFallback = vi.fn()
    const start = vi.fn((engine: ReceiverEngine, castDescriptor: CastDescriptorV1) => engine.play(castDescriptor))
    const rtspDescriptor = descriptor({ src: "rtsp://tv.example/stream" })

    const result = await playWithFallback(registry, rtspDescriptor, { preference: "auto", start, onFallback })

    expect(result).toEqual({ engine: null, started: false })
    expect(onFallback).not.toHaveBeenCalled()
    expect(embeddedEngine.play).not.toHaveBeenCalled()
  })

  it("reports failure when the only registered engine fails to start", async () => {
    const embeddedEngine = stubEngine(false)
    const registry: EngineRegistry = { embedded: embeddedEngine }
    const onFallback = vi.fn()
    const start = vi.fn((engine: ReceiverEngine, castDescriptor: CastDescriptorV1) => engine.play(castDescriptor))

    const result = await playWithFallback(registry, descriptor(), { preference: "auto", start, onFallback })

    expect(result).toEqual({ engine: null, started: false })
    expect(onFallback).not.toHaveBeenCalled()
  })
})
