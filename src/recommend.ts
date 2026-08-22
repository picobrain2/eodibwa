import { pickEnglish, pickKorean } from "./lang";
import { settings } from "./settings";
import type { MediaKind, SearchHit } from "./types";

const TMDB = "https://api.themoviedb.org/3";

export interface RecommendProvider {
  id: number;
  name: string;
  logo?: string;
  hits: SearchHit[];
}

export interface RecommendGenre {
  id: number;
  name: string;
  movieID?: number;
  tvID?: number;
}

export const RECOMMEND_GENRES: RecommendGenre[] = [
  { id: 0, name: "전체" },
  { id: 1, name: "액션", movieID: 28, tvID: 10759 },
  { id: 2, name: "코미디", movieID: 35, tvID: 35 },
  { id: 3, name: "드라마", movieID: 18, tvID: 18 },
  { id: 4, name: "SF", movieID: 878, tvID: 10765 },
  { id: 5, name: "공포", movieID: 27, tvID: 10762 },
  { id: 6, name: "로맨스", movieID: 10749, tvID: 10749 },
  { id: 7, name: "애니메이션", movieID: 16, tvID: 16 },
  { id: 8, name: "다큐", movieID: 99, tvID: 99 },
  { id: 9, name: "스릴러", movieID: 53, tvID: 9648 },
  { id: 10, name: "판타지", movieID: 14, tvID: 10765 },
  { id: 11, name: "범죄", movieID: 80, tvID: 80 },
];

const PROVIDER_IDS: Record<string, number[]> = {
  KR: [8, 867, 356, 97, 337, 119, 350],
  US: [8, 337, 350, 119, 384, 531],
  JP: [8, 337, 350, 119, 84],
  TW: [8, 337, 350, 119],
  HK: [8, 337, 350, 119],
  GB: [8, 337, 350, 119, 39],
};

const CATALOG_TTL_MS = 60 * 60 * 1000;
const TRENDING_TTL_MS = 30 * 60 * 1000;
const catalogCache = new Map<string, { map: Map<number, { name: string; logo?: string }>; expires: number }>();

interface TrendingPool {
  rows: Array<{ item: MediaItem; kind: MediaKind; rank: number }>;
  enMovies: Map<number, MediaItem>;
  enTV: Map<number, MediaItem>;
  expires: number;
}

let trendingPoolCache: TrendingPool | undefined;

interface MediaItem {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
}

interface ProviderDTO {
  provider_id: number;
  provider_name: string;
  logo_path?: string;
}

async function tmdb<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const key = settings.tmdb;
  if (!key) throw new Error("TMDB API 키가 필요합니다.");
  const url = new URL(`${TMDB}${path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const headers: HeadersInit = { Accept: "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`서버가 ${response.status} 오류를 반환했습니다.`);
  return response.json() as Promise<T>;
}

function yearOf(item: MediaItem): string | undefined {
  const date = item.release_date || item.first_air_date || "";
  return date.length >= 4 ? date.slice(0, 4) : undefined;
}

function toHit(item: MediaItem, kind: MediaKind, english?: MediaItem, provider?: { id: number; name: string; logo?: string }): SearchHit {
  const localized = item.title || item.name || "";
  const original = item.original_title || item.original_name || "";
  const enLocalized = english?.title || english?.name || "";
  const enOriginal = english?.original_title || english?.original_name || "";
  return {
    id: `${kind}-${item.id}`,
    tmdbID: item.id,
    kind,
    titleKO: pickKorean([localized, original, enLocalized, enOriginal]),
    titleEN: pickEnglish([enLocalized, enOriginal, original, localized]),
    year: yearOf(item),
    overview: item.overview || english?.overview || "",
    posterPath: item.poster_path || english?.poster_path,
    voteAverage: item.vote_average ?? 0,
    voteCount: item.vote_count ?? 0,
    providerLogo: provider?.logo,
    providerName: provider?.name,
    providerID: provider?.id,
  };
}


export async function fetchTrending(limit = 10): Promise<SearchHit[]> {
  const [ko, en] = await Promise.all([
    tmdb<{ results: MediaItem[] }>("/trending/all/day", { language: "ko-KR" }),
    tmdb<{ results: MediaItem[] }>("/trending/all/day", { language: "en-US" }),
  ]);
  const enByKey = new Map(
    (en.results ?? [])
      .filter((item) => item.media_type === "movie" || item.media_type === "tv")
      .map((item) => [`${item.media_type}-${item.id}`, item]),
  );
  const hits: SearchHit[] = [];
  for (const item of ko.results ?? []) {
    const kind = item.media_type === "movie" || item.media_type === "tv" ? item.media_type : undefined;
    if (!kind) continue;
    hits.push(toHit(item, kind, enByKey.get(`${kind}-${item.id}`)));
    if (hits.length >= limit) break;
  }
  return hits;
}

async function providerCatalog(region: string): Promise<Map<number, { name: string; logo?: string }>> {
  const cached = catalogCache.get(region);
  if (cached && cached.expires > Date.now()) return cached.map;

  const [movies, tv] = await Promise.all([
    tmdb<{ results?: ProviderDTO[] }>("/watch/providers/movie", { watch_region: region }),
    tmdb<{ results?: ProviderDTO[] }>("/watch/providers/tv", { watch_region: region }),
  ]);
  const map = new Map<number, { name: string; logo?: string }>();
  for (const list of [movies.results ?? [], tv.results ?? []]) {
    for (const item of list) {
      map.set(item.provider_id, { name: item.provider_name, logo: item.logo_path });
    }
  }
  catalogCache.set(region, { map, expires: Date.now() + CATALOG_TTL_MS });
  return map;
}

async function getTrendingPool(limit = 20): Promise<TrendingPool> {
  if (trendingPoolCache && trendingPoolCache.expires > Date.now()) return trendingPoolCache;

  const [koMovies, koTV, enMovies, enTV] = await Promise.all([
    tmdb<{ results: MediaItem[] }>("/trending/movie/week", { language: "ko-KR" }),
    tmdb<{ results: MediaItem[] }>("/trending/tv/week", { language: "ko-KR" }),
    tmdb<{ results: MediaItem[] }>("/trending/movie/week", { language: "en-US" }),
    tmdb<{ results: MediaItem[] }>("/trending/tv/week", { language: "en-US" }),
  ]);

  const rows: TrendingPool["rows"] = [];
  (koMovies.results ?? []).slice(0, limit).forEach((item, rank) => rows.push({ item, kind: "movie", rank }));
  (koTV.results ?? []).slice(0, limit).forEach((item, rank) => rows.push({ item, kind: "tv", rank }));

  trendingPoolCache = {
    rows,
    enMovies: new Map((enMovies.results ?? []).map((item) => [item.id, item])),
    enTV: new Map((enTV.results ?? []).map((item) => [item.id, item])),
    expires: Date.now() + TRENDING_TTL_MS,
  };
  return trendingPoolCache;
}

function matchesGenre(item: MediaItem, kind: MediaKind, genre?: RecommendGenre): boolean {
  if (!genre) return true;
  const target = kind === "movie" ? genre.movieID : genre.tvID;
  if (!target) return true;
  return (item.genre_ids ?? []).includes(target);
}

function discoverRows(
  ko: MediaItem[],
  en: MediaItem[],
  kind: MediaKind,
  provider: { id: number; name: string; logo?: string },
): Array<{ hit: SearchHit; popularity: number }> {
  const enByID = new Map(en.map((item) => [item.id, item]));
  return ko.map((item) => ({
    hit: toHit(item, kind, enByID.get(item.id), provider),
    popularity: item.popularity ?? 0,
  }));
}

async function fetchForProvider(
  region: string,
  providerID: number,
  meta: { name: string; logo?: string },
  genre?: RecommendGenre,
  limit = 8,
): Promise<SearchHit[]> {
  const base: Record<string, string> = {
    language: "ko-KR",
    watch_region: region,
    sort_by: "popularity.desc",
    with_watch_providers: String(providerID),
    with_watch_monetization_types: "flatrate|free|ads",
  };
  const provider = { id: providerID, name: meta.name, logo: meta.logo };
  const movieQuery = genre?.movieID ? { ...base, with_genres: String(genre.movieID) } : base;
  const tvQuery = genre?.tvID ? { ...base, with_genres: String(genre.tvID) } : base;

  const [koMovies, koMoviesP2, koTV, koTVP2, enMovies, enMoviesP2, enTV, enTVP2, trending] = await Promise.all([
    tmdb<{ results: MediaItem[] }>("/discover/movie", { ...movieQuery, page: "1" }),
    tmdb<{ results: MediaItem[] }>("/discover/movie", { ...movieQuery, page: "2" }),
    tmdb<{ results: MediaItem[] }>("/discover/tv", { ...tvQuery, page: "1" }),
    tmdb<{ results: MediaItem[] }>("/discover/tv", { ...tvQuery, page: "2" }),
    tmdb<{ results: MediaItem[] }>("/discover/movie", { ...movieQuery, language: "en-US", page: "1" }),
    tmdb<{ results: MediaItem[] }>("/discover/movie", { ...movieQuery, language: "en-US", page: "2" }),
    tmdb<{ results: MediaItem[] }>("/discover/tv", { ...tvQuery, language: "en-US", page: "1" }),
    tmdb<{ results: MediaItem[] }>("/discover/tv", { ...tvQuery, language: "en-US", page: "2" }),
    getTrendingPool(),
  ]);

  const discover = [
    ...discoverRows([...(koMovies.results ?? []), ...(koMoviesP2.results ?? [])], [...(enMovies.results ?? []), ...(enMoviesP2.results ?? [])], "movie", provider),
    ...discoverRows([...(koTV.results ?? []), ...(koTVP2.results ?? [])], [...(enTV.results ?? []), ...(enTVP2.results ?? [])], "tv", provider),
  ];

  const discoverByID = new Map<string, { hit: SearchHit; popularity: number }>();
  for (const row of discover) {
    const existing = discoverByID.get(row.hit.id);
    if (!existing || row.popularity > existing.popularity) discoverByID.set(row.hit.id, row);
  }

  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  if (!genre) {
    for (const { item, kind } of [...trending.rows].sort((a, b) => a.rank - b.rank)) {
      if (!matchesGenre(item, kind, genre)) continue;
      const id = `${kind}-${item.id}`;
      const row = discoverByID.get(id);
      if (!row || seen.has(id)) continue;
      seen.add(id);
      hits.push(row.hit);
      if (hits.length >= limit) return hits;
    }
  }

  const rest = [...discoverByID.values()]
    .filter((row) => !seen.has(row.hit.id))
    .sort((a, b) => b.popularity - a.popularity);

  for (const row of rest) {
    seen.add(row.hit.id);
    hits.push(row.hit);
    if (hits.length >= limit) break;
  }

  return hits;
}

export async function fetchProviderRecommendations(region: string, genreID = 0): Promise<RecommendProvider[]> {
  const genre = RECOMMEND_GENRES.find((item) => item.id === genreID);
  const catalog = await providerCatalog(region);
  const ids = PROVIDER_IDS[region] ?? PROVIDER_IDS.KR;
  const rows = await Promise.all(
    ids.map(async (id) => {
      const meta = catalog.get(id) ?? { name: `Provider ${id}` };
      const hits = await fetchForProvider(region, id, meta, genreID === 0 ? undefined : genre, 8);
      if (!hits.length) return null;
      return { id, name: meta.name, logo: meta.logo, hits } as RecommendProvider;
    }),
  );
  return rows.filter((row): row is RecommendProvider => row !== null);
}

export async function loadRecommendations(region: string, genreID = 0): Promise<{ trending: SearchHit[]; providers: RecommendProvider[] }> {
  const [trending, providers] = await Promise.all([
    fetchTrending(10),
    fetchProviderRecommendations(region, genreID),
  ]);
  return { trending, providers };
}
