// Pure audio/subtitle track matching: normalize BCP-47-ish language tags, pick a remembered track.
export interface TrackCandidate {
  id: number
  lang: string | null
  title: string | null
}

export interface TrackPreference {
  lang: string | null
  id: number | null
  title: string | null
}

const THREE_LETTER_TO_TWO: Record<string, string> = {
  eng: "en",
  ger: "de",
  deu: "de",
  fre: "fr",
  fra: "fr",
  spa: "es",
  ita: "it",
  por: "pt",
  rus: "ru",
  dut: "nl",
  nld: "nl",
  pol: "pl",
  tur: "tr",
  ara: "ar",
  urd: "ur",
  hin: "hi",
  ind: "id",
  jpn: "ja",
  chi: "zh",
  zho: "zh",
  swe: "sv",
  nor: "no",
  dan: "da",
  fin: "fi",
  cze: "cs",
  ces: "cs",
  hun: "hu",
  gre: "el",
  ell: "el",
  heb: "he",
  kor: "ko",
  tha: "th",
  vie: "vi",
  ukr: "uk",
  ron: "ro",
  rum: "ro",
  bul: "bg",
  hrv: "hr",
  srp: "sr",
  slk: "sk",
  slo: "sk",
  slv: "sl",
  cat: "ca",
  fil: "tl",
}

const UNKNOWN_LANG_TOKENS = new Set(["und", "unknown", "mul", "zxx"])

export function normalizeLang(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null
  const primary = trimmed.split(/[-_]/)[0]
  if (!primary || UNKNOWN_LANG_TOKENS.has(primary)) return null
  if (primary.length === 3) return THREE_LETTER_TO_TWO[primary] || primary
  return primary
}

export function pickTrack(
  tracks: TrackCandidate[],
  pref: TrackPreference | null | undefined
): number | null {
  if (!pref) return null

  const wantLang = normalizeLang(pref.lang)
  let candidates: TrackCandidate[]

  if (wantLang != null) {
    candidates = tracks.filter((track) => normalizeLang(track.lang) === wantLang)
    if (!candidates.length) return null
  } else {
    candidates = pref.id != null ? tracks.filter((track) => track.id === pref.id) : []
    if (!candidates.length && pref.title != null) {
      const wantTitle = pref.title.trim().toLowerCase()
      candidates = tracks.filter(
        (track) => track.title != null && track.title.trim().toLowerCase() === wantTitle
      )
    }
    if (!candidates.length) return null
  }

  const idMatch = candidates.find((track) => track.id === pref.id)
  if (idMatch) return idMatch.id

  if (pref.title != null) {
    const wantTitle = pref.title.trim().toLowerCase()
    const titleMatch = candidates.find(
      (track) => track.title != null && track.title.trim().toLowerCase() === wantTitle
    )
    if (titleMatch) return titleMatch.id
  }

  return candidates[0].id
}
