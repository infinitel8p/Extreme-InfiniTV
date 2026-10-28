import { describe, it, expect } from "vitest"
import { parseSrt, parseWebVtt, parseSubtitleText, cuesToSrt } from "../src/scripts/lib/subtitle-parse"

describe("parseSrt", () => {
  it("parses basic cues", () => {
    const cues = parseSrt("1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:01:00,250 --> 00:01:02,000\nWorld\n")
    expect(cues).toEqual([
      { startSeconds: 1, endSeconds: 2.5, text: "Hello" },
      { startSeconds: 60.25, endSeconds: 62, text: "World" },
    ])
  })

  it("handles BOM and CRLF", () => {
    const cues = parseSrt(
      "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nThere\r\n"
    )
    expect(cues.map((cue) => cue.text)).toEqual(["Hi", "There"])
  })

  it("accepts a dot millisecond separator", () => {
    expect(parseSrt("1\n00:00:01.500 --> 00:00:02.000\nHi")[0].startSeconds).toBe(1.5)
  })

  it("keeps multi-line text and tags", () => {
    const cues = parseSrt("1\n00:00:01,000 --> 00:00:02,000\n<i>Line one</i>\nLine two\n")
    expect(cues[0].text).toBe("<i>Line one</i>\nLine two")
  })

  it("strips ASS override tags", () => {
    expect(parseSrt("1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Top text")[0].text).toBe("Top text")
  })

  it("skips malformed blocks", () => {
    const cues = parseSrt("1\nnot a timing\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nOk\n")
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe("Ok")
  })
})

describe("parseWebVtt", () => {
  it("handles header, notes, ids and hour-less timestamps", () => {
    const cues = parseWebVtt(
      "WEBVTT - title\n\nNOTE a comment\n\nintro\n00:01.000 --> 00:02.500 align:start\nHello\n\n01:00:00.000 --> 01:00:01.000\nLate\n"
    )
    expect(cues).toEqual([
      { startSeconds: 1, endSeconds: 2.5, text: "Hello" },
      { startSeconds: 3600, endSeconds: 3601, text: "Late" },
    ])
  })
})

describe("parseSubtitleText", () => {
  it("sniffs WEBVTT", () => {
    expect(parseSubtitleText("WEBVTT\n\n00:01.000 --> 00:02.000\nA")).toHaveLength(1)
  })

  it("falls back to SRT", () => {
    expect(parseSubtitleText("1\n00:00:01,000 --> 00:00:02,000\nA")).toHaveLength(1)
  })

  it("returns nothing for empty input", () => {
    expect(parseSubtitleText("")).toEqual([])
  })
})

describe("cuesToSrt", () => {
  it("round-trips through parseSrt", () => {
    const cues = [
      { startSeconds: 1, endSeconds: 2.5, text: "Hello\nthere" },
      { startSeconds: 3661.25, endSeconds: 3662, text: "Late" },
    ]
    expect(cuesToSrt(cues)).toContain("01:01:01,250 --> 01:01:02,000")
    expect(parseSrt(cuesToSrt(cues))).toEqual(cues)
  })
})
