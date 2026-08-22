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

function mergeLocalized(ko: MediaItem[], en: MediaItem[], kind: MediaKind, provider?: { id: number; name: string; logo?: string }): SearchHit[] {
  const enByID = new Map(en.map((item) => [item.id, item]));
  return ko.map((item) => toHit(item, kind, enByID.get(item.id), provider));
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
  return map;
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
    page: "1",
    with_watch_providers: String(providerID),
    with_watch_monetization_types: "flatrate|free|ads",
  };
  const provider = { id: providerID, name: meta.name, logo: meta.logo };
  const movieQuery = genre?.movieID ? { ...base, with_genres: String(genre.movieID) } : base;
  const tvQuery = genre?.tvID ? { ...base, with_genres: String(genre.tvID) } : base;
  const [koMovies, koTV, enMovies, enTV] = await Promise.all([
    tmdb<{ results: MediaItem[] }>("/discover/movie", movieQuery),
    tmdb<{ results: MediaItem[] }>("/discover/tv", tvQuery),
    tmdb<{ results: MediaItem[] }>("/discover/movie", { ...movieQuery, language: "en-US" }),
    tmdb<{ results: MediaItem[] }>("/discover/tv", { ...tvQuery, language: "en-US" }),
  ]);
  const seen = new Set<string>();
  const hits = [
    ...mergeLocalized(koMovies.results ?? [], enMovies.results ?? [], "movie", provider),
    ...mergeLocalized(koTV.results ?? [], enTV.results ?? [], "tv", provider),
  ]
    .filter((hit) => {
      if (seen.has(hit.id)) return false;
      seen.add(hit.id);
      return true;
    })
    .sort((a, b) => b.voteCount - a.voteCount || b.voteAverage - a.voteAverage)
    .slice(0, limit);
  return hits;
}

export async function fetchProviderRecommendations(region: string, genreID = 0): Promise<RecommendProvider[]> {
  const genre = RECOMMEND_GENRES.find((item) => item.id === genreID);
  const catalog = await providerCatalog(region);
  const ids = PROVIDER_IDS[region] ?? PROVIDER_IDS.KR;
  const providers: RecommendProvider[] = [];
  for (const id of ids) {
    const meta = catalog.get(id) ?? { name: `Provider ${id}` };
    const hits = await fetchForProvider(region, id, meta, genreID === 0 ? undefined : genre, 8);
    if (!hits.length) continue;
    providers.push({ id, name: meta.name, logo: meta.logo, hits });
  }
  return providers;
}

export async function loadRecommendations(region: string, genreID = 0): Promise<{ trending: SearchHit[]; providers: RecommendProvider[] }> {
  const [trending, providers] = await Promise.all([
    fetchTrending(10),
    fetchProviderRecommendations(region, genreID),
  ]);
  return { trending, providers };
}
