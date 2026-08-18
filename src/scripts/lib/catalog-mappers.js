// Pure Xtream row mappers shared by catalog.js and (later) native ingest.

import { normalize } from "@/scripts/lib/text.js"

export function parseCategoriesToMap(data) {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.categories)
    ? data.categories
    : []
  return new Map(
    arr
      .filter((c) => c && c.category_id != null)
      .map((c) => [String(c.category_id), String(c.category_name || "").trim()])
  )
}

export function mapXtreamLiveRows(rawRows, categoryMap) {
  return (rawRows || [])
    .map((ch) => {
      const name = String(ch.name || "")
      const ids =
        (Array.isArray(ch.category_ids) &&
          ch.category_ids.length &&
          ch.category_ids) ||
        (ch.category_id != null ? [ch.category_id] : [])
      let category = String(ch.category_name || "").trim()
      if (!category && ids.length && categoryMap?.size) {
        for (const id of ids) {
          const n = categoryMap.get(String(id))
          if (n) {
            category = n
            break
          }
        }
      }
      return {
        id: Number(ch.stream_id),
        name,
        category,
        logo: ch.stream_icon || null,
        tvgId: String(ch.epg_channel_id || "") || undefined,
        chno: Number(ch.num) || undefined,
        norm: normalize(name + " " + category),
        tvArchive: Number(ch.tv_archive) || 0,
        tvArchiveDuration: Number(ch.tv_archive_duration) || 0,
      }
    })
    .filter((x) => x.id && x.name)
}

export function mapXtreamVodRows(rawRows, categoryMap) {
  return (rawRows || [])
    .map((m) => {
      const name = String(m.name || m.title || "")
      const id = Number(m.stream_id || m.id)
      const logo = m.stream_icon || m.cover || null
      const year = String(m.year || m.releaseDate || "").trim() || ""
      const rating = m.rating || m.rating_5based || m.vote_average || ""
      const duration = m.duration || m.runtime || m.duration_secs || ""
      const categoryId =
        (Array.isArray(m.category_ids) &&
          m.category_ids.length &&
          m.category_ids[0]) ||
        m.category_id
      let category = String(m.category_name || "").trim()
      if (!category && categoryId != null && categoryMap?.size) {
        category = categoryMap.get(String(categoryId)) || ""
      }
      const added = Number(m.added) || 0
      const tmdb = Number(m.tmdb) || Number(m.tmdb_id) || null
      return {
        id,
        name,
        logo: logo || null,
        year,
        rating: rating ? String(rating) : "",
        duration: duration ? String(duration) : "",
        category,
        plot: "",
        added,
        norm: normalize(`${name} ${category} ${year}`),
        tmdb,
      }
    })
    .filter((m) => m.id && m.name)
    .sort((a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" })
    )
}

/** True when `rows` predate the `tmdb` field and need a background backfill. */
export function rowsNeedTmdbBackfill(rows) {
  if (!Array.isArray(rows) || !rows.length) return false
  const firstRow = rows[0]
  return !!firstRow && typeof firstRow === "object" && !("tmdb" in firstRow)
}

export function mapXtreamSeriesRows(rawRows, categoryMap) {
  return (rawRows || [])
    .map((s) => {
      const name = String(s.name || s.title || "")
      const id = Number(s.series_id || s.id)
      const logo = s.cover || s.stream_icon || null
      const year = String(
        s.year || s.releaseDate || s.release_date || ""
      ).trim()
      const rating = s.rating || s.rating_5based || ""
      const categoryId =
        (Array.isArray(s.category_ids) &&
          s.category_ids.length &&
          s.category_ids[0]) ||
        s.category_id
      let category = String(s.category_name || "").trim()
      if (!category && categoryId != null && categoryMap?.size) {
        category = categoryMap.get(String(categoryId)) || ""
      }
      const added =
        Number(s.last_modified) ||
        Number(s.added) ||
        Number(
          s.releaseDate ? Date.parse(s.releaseDate) / 1000 : 0
        ) ||
        0
      const tmdb = Number(s.tmdb) || Number(s.tmdb_id) || null
      return {
        id,
        name,
        logo: logo || null,
        year: year || "",
        rating: rating ? String(rating) : "",
        category,
        plot: s.plot || "",
        added,
        norm: normalize(`${name} ${category} ${year}`),
        tmdb,
        genre: String(s.genre || "").trim(),
      }
    })
    .filter((s) => s.id && s.name)
    .sort((a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" })
    )
}

/** True when `rows` predate the `genre` field and need a background backfill. */
export function rowsNeedGenreBackfill(rows) {
  if (!Array.isArray(rows) || !rows.length) return false
  const firstRow = rows[0]
  return !!firstRow && typeof firstRow === "object" && !("genre" in firstRow)
}
