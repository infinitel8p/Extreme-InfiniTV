package com.infinitel8p.xtream

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

class SubtitleTimeShiftTest {

  @Test
  fun srtShiftKeepsSuffix() {
    val input = "1\n00:00:01,000 --> 00:00:02,500 X1:100 X2:200\nHello\n"
    val expected = "1\n00:00:01,500 --> 00:00:03,000 X1:100 X2:200\nHello\n"
    assertEquals(expected, SubtitleTimeShift.shift(input, 500, "application/x-subrip"))
  }

  @Test
  fun srtNegativeShiftClampsAtZero() {
    val input = "1\n00:00:01,000 --> 00:00:03,000\nHi\n"
    val expected = "1\n00:00:00,000 --> 00:00:00,000\nHi\n"
    assertEquals(expected, SubtitleTimeShift.shift(input, -5000, "application/x-subrip"))
  }

  @Test
  fun vttShiftKeepsCrlfAndSettings() {
    val input = "WEBVTT\r\n\r\n01:02.500 --> 01:03.000 align:start\r\nText\r\n"
    val expected = "WEBVTT\r\n\r\n01:02.750 --> 01:03.250 align:start\r\nText\r\n"
    assertEquals(expected, SubtitleTimeShift.shift(input, 250, "text/vtt"))
  }

  @Test
  fun hourCarry() {
    val input = "1\n00:59:59,900 --> 01:00:00,000\nHi\n"
    val expected = "1\n01:00:00,100 --> 01:00:00,200\nHi\n"
    assertEquals(expected, SubtitleTimeShift.shift(input, 200, null))
  }

  @Test
  fun bomPrefixedSrtOnlyTimestampsChange() {
    val input = "\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nHello 00:00:09,000\r\n"
    val expected = "\uFEFF1\r\n00:00:01,100 --> 00:00:02,100\r\nHello 00:00:09,000\r\n"
    assertEquals(expected, SubtitleTimeShift.shift(input, 100, null))
  }

  @Test
  fun asciiDigitsUnderArabicLocale() {
    val previous = Locale.getDefault()
    try {
      Locale.setDefault(Locale.forLanguageTag("ar"))
      val input = "1\n00:00:01,000 --> 00:00:02,000\nHi\n"
      val expected = "1\n00:00:01,250 --> 00:00:02,250\nHi\n"
      assertEquals(expected, SubtitleTimeShift.shift(input, 250, null))
    } finally {
      Locale.setDefault(previous)
    }
  }
}
