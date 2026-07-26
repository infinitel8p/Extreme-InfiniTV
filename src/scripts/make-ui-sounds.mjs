// Synthesizes ui-nav / ui-select / ui-confirm in public/sounds/ (ui-launch.wav
// is a recording, see the README there). Run: node ./src/scripts/make-ui-sounds.mjs

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SAMPLE_RATE = 48000
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../public/sounds")

const TAU = Math.PI * 2

/** One decaying partial: sine at freq, cosine-ramp attack, exponential decay. */
function partial(samples, { freq, gain, attackMs, decayTauMs, startMs = 0, detuneCents = 0 }) {
  const startSample = Math.floor((startMs / 1000) * SAMPLE_RATE)
  const attackSamples = Math.max(1, Math.floor((attackMs / 1000) * SAMPLE_RATE))
  const decayTauSamples = (decayTauMs / 1000) * SAMPLE_RATE
  const hz = freq * Math.pow(2, detuneCents / 1200)
  for (let i = startSample; i < samples.length; i++) {
    const t = i - startSample
    const attack = t < attackSamples ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attackSamples) : 1
    const decay = Math.exp(-t / decayTauSamples)
    samples[i] += gain * attack * decay * Math.sin((TAU * hz * t) / SAMPLE_RATE)
  }
}

/** Scale so the loudest sample sits at `peak`, then cosine-fade the tail to zero. */
function finalize(samples, peak, fadeOutMs = 12) {
  let max = 0
  for (const value of samples) max = Math.max(max, Math.abs(value))
  const scale = max > 0 ? peak / max : 0
  const fadeSamples = Math.floor((fadeOutMs / 1000) * SAMPLE_RATE)
  for (let i = 0; i < samples.length; i++) {
    let value = samples[i] * scale
    const fromEnd = samples.length - 1 - i
    if (fromEnd < fadeSamples) value *= 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / fadeSamples)
    samples[i] = value
  }
}

function toWav(samples) {
  const dataBytes = samples.length * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write("RIFF", 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write("WAVE", 8)
  buf.write("fmt ", 12)
  buf.writeUInt32LE(16, 16) // PCM chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write("data", 36)
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  }
  return buf
}

function render(durationMs, peak, partials) {
  const samples = new Float64Array(Math.floor((durationMs / 1000) * SAMPLE_RATE))
  for (const p of partials) partial(samples, p)
  finalize(samples, peak)
  return samples
}

// Focus tick: muted woodblock "thock".
const nav = render(60, 0.16, [
  { freq: 1975, gain: 1.0, attackMs: 1.5, decayTauMs: 9 },
  { freq: 987.5, gain: 0.45, attackMs: 1.5, decayTauMs: 14 },
])

// Activation: upward micro-arp, F#5 to C#6.
const select = render(140, 0.18, [
  { freq: 740, gain: 1.0, attackMs: 2, decayTauMs: 28 },
  { freq: 1480, gain: 0.16, attackMs: 2, decayTauMs: 20 },
  { freq: 1108.7, gain: 0.85, attackMs: 2, decayTauMs: 34, startMs: 48 },
  { freq: 2217.4, gain: 0.12, attackMs: 2, decayTauMs: 22, startMs: 48 },
])

// Confirm: warm C5+E5 dyad with bell partials.
const confirm = render(260, 0.18, [
  { freq: 523.25, gain: 1.0, attackMs: 5, decayTauMs: 80 },
  { freq: 659.25, gain: 0.8, attackMs: 5, decayTauMs: 75, startMs: 10 },
  { freq: 1046.5, gain: 0.15, attackMs: 5, decayTauMs: 55 },
  { freq: 1564.9, gain: 0.05, attackMs: 5, decayTauMs: 45 },
])

mkdirSync(OUT_DIR, { recursive: true })
for (const [name, samples] of [
  ["ui-nav", nav],
  ["ui-select", select],
  ["ui-confirm", confirm],
]) {
  const file = join(OUT_DIR, `${name}.wav`)
  writeFileSync(file, toWav(samples))
  console.log(`${file} (${((samples.length / SAMPLE_RATE) * 1000).toFixed(0)}ms)`)
}
