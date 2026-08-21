package com.infinitel8p.xtream

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DreamManifestTest {

  @Test
  fun `parses valid entries`() {
    val json = """
      {
        "v": 1,
        "at": 1000,
        "ua": "TestUA/1.0",
        "entries": [
          { "kind": "vod", "id": "1", "title": "Movie One", "posterUrl": "https://x/p1.jpg", "backdropUrl": "https://x/b1.jpg", "logoUrl": "https://x/l1.png", "tier": "a" },
          { "kind": "series", "id": "2", "title": "Show Two", "posterUrl": "https://x/p2.jpg" }
        ]
      }
    """.trimIndent()

    val data = DreamManifest.parse(json)

    assertEquals(1000L, data.at)
    assertEquals("TestUA/1.0", data.ua)
    assertEquals(2, data.entries.size)
    assertEquals("1", data.entries[0].id)
    assertEquals("https://x/b1.jpg", data.entries[0].backdropUrl)
    assertNull(data.entries[1].backdropUrl)
  }

  @Test
  fun `skips malformed entries but keeps valid ones`() {
    val json = """
      {
        "at": 0,
        "entries": [
          { "kind": "movie", "id": "1", "title": "Wrong kind" },
          { "kind": "vod", "id": "", "title": "Missing id" },
          { "kind": "vod", "title": "Missing id field" },
          { "kind": "vod", "id": "3", "title": "" },
          "not-an-object",
          { "kind": "vod", "id": "4", "title": "Valid" }
        ]
      }
    """.trimIndent()

    val data = DreamManifest.parse(json)

    assertEquals(1, data.entries.size)
    assertEquals("4", data.entries[0].id)
  }

  @Test
  fun `returns empty data for garbage input`() {
    val data = DreamManifest.parse("not json at all")

    assertTrue(data.entries.isEmpty())
    assertNull(data.ua)
    assertEquals(0L, data.at)
  }

  @Test
  fun `returns empty data for wrong top-level shape`() {
    val data = DreamManifest.parse("[1,2,3]")

    assertTrue(data.entries.isEmpty())
  }

  @Test
  fun `caps entries at 50`() {
    val entriesJson = (1..80).joinToString(",") {
      "{ \"kind\": \"vod\", \"id\": \"$it\", \"title\": \"Title $it\", \"posterUrl\": \"https://x/$it.jpg\" }"
    }
    val json = "{ \"at\": 0, \"entries\": [$entriesJson] }"

    val data = DreamManifest.parse(json)

    assertEquals(50, data.entries.size)
  }

  @Test
  fun `blank optional fields become null`() {
    val json = """
      {
        "entries": [
          { "kind": "vod", "id": "1", "title": "Title", "posterUrl": "", "backdropUrl": "  ", "logoUrl": "" }
        ]
      }
    """.trimIndent()

    val data = DreamManifest.parse(json)

    assertEquals(1, data.entries.size)
    assertNull(data.entries[0].posterUrl)
    assertNull(data.entries[0].backdropUrl)
    assertNull(data.entries[0].logoUrl)
  }
}
