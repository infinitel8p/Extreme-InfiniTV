// Canonical genre taxonomy: pure name/TMDb-id matching, no fetch/storage/DOM.

import { normalize } from "@/scripts/lib/text.ts"

export type GenreId =
  | "action"
  | "adventure"
  | "animation"
  | "comedy"
  | "crime"
  | "documentary"
  | "drama"
  | "family"
  | "fantasy"
  | "history"
  | "horror"
  | "music"
  | "mystery"
  | "romance"
  | "sci-fi"
  | "thriller"
  | "war"
  | "western"

export interface CanonicalGenre {
  id: GenreId
  labelKey: string
  tmdbMovieIds: number[]
  tmdbTvIds: number[]
}

const GENRE_IDS: GenreId[] = [
  "action",
  "adventure",
  "animation",
  "comedy",
  "crime",
  "documentary",
  "drama",
  "family",
  "fantasy",
  "history",
  "horror",
  "music",
  "mystery",
  "romance",
  "sci-fi",
  "thriller",
  "war",
  "western",
]

// 10770 (TV Movie) is deliberately unmapped.
const TMDB_MOVIE_GENRE_MAP: Record<number, GenreId[]> = {
  28: ["action"],
  12: ["adventure"],
  16: ["animation"],
  35: ["comedy"],
  80: ["crime"],
  99: ["documentary"],
  18: ["drama"],
  10751: ["family"],
  14: ["fantasy"],
  36: ["history"],
  27: ["horror"],
  10402: ["music"],
  9648: ["mystery"],
  10749: ["romance"],
  878: ["sci-fi"],
  53: ["thriller"],
  10752: ["war"],
  37: ["western"],
}

// 10763 (News) / 10764 (Reality) / 10766 (Soap) / 10767 (Talk) are deliberately unmapped.
// Order matters for the multi-genre ids below (10759, 10765): it drives output order.
const TMDB_TV_GENRE_MAP: Record<number, GenreId[]> = {
  10759: ["action", "adventure"],
  16: ["animation"],
  35: ["comedy"],
  80: ["crime"],
  99: ["documentary"],
  18: ["drama"],
  10751: ["family"],
  10762: ["family"],
  9648: ["mystery"],
  10765: ["sci-fi", "fantasy"],
  10768: ["war"],
  37: ["western"],
}

function idsForGenre(map: Record<number, GenreId[]>, genreId: GenreId): number[] {
  return Object.keys(map)
    .map(Number)
    .filter((tmdbId) => map[tmdbId].includes(genreId))
}

export const CANONICAL_GENRES: CanonicalGenre[] = GENRE_IDS.map((id) => ({
  id,
  labelKey: `genres.${id}`,
  tmdbMovieIds: idsForGenre(TMDB_MOVIE_GENRE_MAP, id),
  tmdbTvIds: idsForGenre(TMDB_TV_GENRE_MAP, id),
}))

const GENRE_SYNONYMS: Record<GenreId, string[]> = {
  action: [
    "action",
    "aktion",
    "accion",
    "acción",
    "azione",
    "acao",
    "ação",
    "aksiyon",
    "actie",
    "akcja",
    "боевик",
    "δραση",
    "δράση",
    "اكشن",
    "أكشن",
  ],
  adventure: [
    "adventure",
    "abenteuer",
    "aventure",
    "aventura",
    "avventura",
    "macera",
    "avontuur",
    "przygoda",
    "przygodowy",
    "приключения",
    "περιπετεια",
    "περιπέτεια",
    "مغامرة",
  ],
  animation: [
    "animation",
    "animatie",
    "animacion",
    "animación",
    "animazione",
    "animacao",
    "animação",
    "animasyon",
    "animacja",
    "мультфильм",
    "анимация",
    "κινουμενα σχεδια",
    "κινούμενα σχέδια",
    "رسوم متحركة",
  ],
  comedy: [
    "comedy",
    "komodie",
    "komödie",
    "comedie",
    "comédie",
    "comedia",
    "commedia",
    "komedi",
    "komedia",
    "комедия",
    "κωμωδια",
    "κωμωδία",
    "كوميديا",
  ],
  crime: [
    "crime",
    "krimi",
    "kriminalfilm",
    "policier",
    "crimen",
    "poliziesco",
    "suc",
    "suç",
    "misdaad",
    "kryminal",
    "kryminał",
    "криминал",
    "εγκλημα",
    "έγκλημα",
    "جريمة",
  ],
  documentary: [
    "documentary",
    "dokumentation",
    "doku",
    "documentaire",
    "documental",
    "documentario",
    "documentário",
    "belgesel",
    "dokumentalny",
    "документальный",
    "ντοκιμαντερ",
    "ντοκιμαντέρ",
    "وثائقي",
  ],
  drama: [
    "drama",
    "drame",
    "dramma",
    "dram",
    "dramat",
    "драма",
    "δραμα",
    "δράμα",
    "دراما",
  ],
  family: [
    "family",
    "familie",
    "famille",
    "familia",
    "famiglia",
    "família",
    "aile",
    "familijny",
    "rodzinny",
    "семейный",
    "οικογενεια",
    "οικογένεια",
    "عائلي",
  ],
  fantasy: [
    "fantasy",
    "fantastique",
    "fantasia",
    "fantasía",
    "fantastik",
    "φαντασιας",
    "φαντασίας",
    "خيال",
  ],
  history: [
    "history",
    "historical",
    "geschichte",
    "historie",
    "histoire",
    "historia",
    "storia",
    "história",
    "tarih",
    "geschiedenis",
    "historyczny",
    "истории",
    "история",
    "ιστορια",
    "ιστορία",
    "تاريخي",
  ],
  horror: [
    "horror",
    "horreur",
    "terror",
    "orrore",
    "korku",
    "ужасы",
    "τρομου",
    "τρόμου",
    "τρομος",
    "τρόμος",
    "رعب",
  ],
  music: [
    "music",
    "musical",
    "musik",
    "musique",
    "musica",
    "música",
    "muzik",
    "müzik",
    "muziek",
    "muzyczny",
    "музыка",
    "μουσικη",
    "μουσική",
    "موسيقى",
  ],
  mystery: [
    "mystery",
    "mystere",
    "mystère",
    "misterio",
    "mistero",
    "mistério",
    "gizem",
    "mysterie",
    "tajemnica",
    "мистика",
    "μυστηριο",
    "μυστήριο",
    "غموض",
  ],
  romance: [
    "romance",
    "romantik",
    "liebesfilm",
    "romantico",
    "romantik film",
    "romans",
    "мелодрама",
    "романтика",
    "ρομαντικο",
    "ρομαντικό",
    "رومانسي",
  ],
  "sci-fi": [
    "sci fi",
    "scifi",
    "science fiction",
    "ciencia ficcion",
    "ciencia ficción",
    "fantascienza",
    "ficcao cientifica",
    "ficção científica",
    "bilim kurgu",
    "фантастика",
    "επιστημονικη φαντασια",
    "επιστημονική φαντασία",
    "خيال علمي",
  ],
  thriller: [
    "thriller",
    "suspenso",
    "suspense",
    "gerilim",
    "триллер",
    "θριλερ",
    "θρίλερ",
    "اثارة",
    "إثارة",
  ],
  war: [
    "war",
    "krieg",
    "guerre",
    "guerra",
    "savas",
    "savaş",
    "oorlog",
    "wojenny",
    "военный",
    "πολεμος",
    "πόλεμος",
    "حرب",
  ],
  western: [
    "western",
    "faroeste",
    "vahsi bati",
    "vahşi batı",
    "γουεστερν",
    "γουέστερν",
    "غربي",
  ],
}

function normalizeForMatch(raw: string): string {
  return normalize(raw.replace(/[&+]/g, " "))
}

const GENRE_SYNONYM_TOKENS: Record<GenreId, string[][]> = Object.fromEntries(
  GENRE_IDS.map((genreId) => [
    genreId,
    GENRE_SYNONYMS[genreId].map((phrase) => normalizeForMatch(phrase).split(" ").filter(Boolean)),
  ]),
) as Record<GenreId, string[][]>

function tokensContainPhrase(tokens: string[], phraseTokens: string[]): boolean {
  if (!phraseTokens.length) return false
  for (let i = 0; i <= tokens.length - phraseTokens.length; i++) {
    let matches = true
    for (let j = 0; j < phraseTokens.length; j++) {
      if (tokens[i + j] !== phraseTokens[j]) {
        matches = false
        break
      }
    }
    if (matches) return true
  }
  return false
}

export function parseGenreString(raw: string | null | undefined): GenreId[] {
  if (!raw) return []
  const tokens = normalizeForMatch(raw).split(" ").filter(Boolean)
  if (!tokens.length) return []
  const matched: GenreId[] = []
  for (const genreId of GENRE_IDS) {
    const phraseLists = GENRE_SYNONYM_TOKENS[genreId]
    if (phraseLists.some((phraseTokens) => tokensContainPhrase(tokens, phraseTokens))) {
      matched.push(genreId)
    }
  }
  return matched
}

export function genreForCategoryName(name: string | null | undefined): GenreId[] {
  return parseGenreString(name)
}

export function genresForTmdbIds(kind: "vod" | "series", tmdbGenreIds: number[]): GenreId[] {
  const map = kind === "vod" ? TMDB_MOVIE_GENRE_MAP : TMDB_TV_GENRE_MAP
  const result: GenreId[] = []
  for (const tmdbGenreId of tmdbGenreIds) {
    const genreIds = map[tmdbGenreId]
    if (!genreIds) continue
    for (const genreId of genreIds) {
      if (!result.includes(genreId)) result.push(genreId)
    }
  }
  return result
}
