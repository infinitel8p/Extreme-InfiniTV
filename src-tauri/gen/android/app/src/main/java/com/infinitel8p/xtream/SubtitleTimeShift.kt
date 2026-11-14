package com.infinitel8p.xtream

import java.util.Locale

object SubtitleTimeShift {

  private val SRT_TIMESTAMP = Regex("""(\d{1,2}):(\d{2}):(\d{2})([,.])(\d{1,3})""")
  private val VTT_TIMESTAMP = Regex("""(?:(\d{1,3}):)?(\d{2}):(\d{2})(\.)(\d{1,3})""")

  fun shift(text: String, deltaMs: Int, mime: String?): String {
    if (deltaMs == 0) return text
    val isVtt = mime == "text/vtt" || text.trimStart('\uFEFF', ' ', '\t', '\r', '\n').startsWith("WEBVTT")
    val pattern = if (isVtt) VTT_TIMESTAMP else SRT_TIMESTAMP
    return text.split("\n").joinToString("\n") { line ->
      if (!line.contains("-->")) line else shiftLine(line, deltaMs, pattern)
    }
  }

  private fun shiftLine(line: String, deltaMs: Int, pattern: Regex): String =
    pattern.replace(line) { match ->
      val hoursText = match.groupValues[1]
      val minutes = match.groupValues[2].toLong()
      val seconds = match.groupValues[3].toLong()
      val separator = match.groupValues[4]
      val millis = match.groupValues[5].padEnd(3, '0').toLong()
      val hours = if (hoursText.isEmpty()) 0L else hoursText.toLong()
      val totalMs = (((hours * 60 + minutes) * 60 + seconds) * 1000 + millis + deltaMs).coerceAtLeast(0L)
      val outHours = totalMs / 3_600_000
      val outMinutes = (totalMs / 60_000) % 60
      val outSeconds = (totalMs / 1000) % 60
      val outMillis = totalMs % 1000
      val hoursPart = if (hoursText.isNotEmpty() || outHours > 0) {
        String.format(Locale.ROOT, "%0${maxOf(2, hoursText.length)}d:", outHours)
      } else ""
      hoursPart + String.format(Locale.ROOT, "%02d:%02d%s%03d", outMinutes, outSeconds, separator, outMillis)
    }
}
