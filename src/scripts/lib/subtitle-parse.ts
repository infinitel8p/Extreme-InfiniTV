import type { SubtitleCue } from "@/scripts/lib/mp4-subtitles.ts"

const TIMING_PATTERN =
  /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/
const ASS_OVERRIDE_PATTERN = /\{\\[^}]*\}/g

function toSeconds(hours: string | undefined, minutes: string, seconds: string, millis: string): number {
  const fraction = Number(millis.padEnd(3, "0")) / 1000
  return Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds) + fraction
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function splitBlocks(text: string): string[][] {
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n")
  const blocks: string[][] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) blocks.push(current)
      current = []
    } else {
      current.push(line)
    }
  }
  if (current.length) blocks.push(current)
  return blocks
}

function parseBlocks(blocks: string[][]): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  for (const block of blocks) {
    const timingIndex = block.findIndex((line) => TIMING_PATTERN.test(line))
    if (timingIndex < 0 || timingIndex > 1) continue
    const match = TIMING_PATTERN.exec(block[timingIndex])
    if (!match) continue
    const text = block.slice(timingIndex + 1).join("\n").replace(ASS_OVERRIDE_PATTERN, "").trim()
    if (!text) continue
    const startSeconds = toSeconds(match[1], match[2], match[3], match[4])
    const endSeconds = toSeconds(match[5], match[6], match[7], match[8])
    if (endSeconds < startSeconds) continue
    cues.push({ startSeconds, endSeconds, text })
  }
  return cues
}

export function parseSrt(text: string): SubtitleCue[] {
  return parseBlocks(splitBlocks(text))
}

export function parseWebVtt(text: string): SubtitleCue[] {
  const blocks = splitBlocks(text).filter((block) => {
    const first = block[0].trim()
    return !/^(NOTE|STYLE|REGION)(\s|$)/.test(first) && !first.startsWith("WEBVTT")
  })
  return parseBlocks(blocks)
}

export function parseSubtitleText(text: string): SubtitleCue[] {
  const stripped = stripBom(text)
  return stripped.trimStart().startsWith("WEBVTT") ? parseWebVtt(stripped) : parseSrt(stripped)
}

function srtTimestamp(totalSeconds: number): string {
  const totalMillis = Math.max(0, Math.round(totalSeconds * 1000))
  const hours = Math.floor(totalMillis / 3600000)
  const minutes = Math.floor((totalMillis % 3600000) / 60000)
  const seconds = Math.floor((totalMillis % 60000) / 1000)
  const millis = totalMillis % 1000
  const pad = (value: number, width: number) => String(value).padStart(width, "0")
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`
}

export function cuesToSrt(cues: SubtitleCue[]): string {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTimestamp(cue.startSeconds)} --> ${srtTimestamp(cue.endSeconds)}\n${cue.text}\n`,
    )
    .join("\n")
}
