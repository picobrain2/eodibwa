import { pickEnglish, pickKorean } from "./lang";
import { settings } from "./settings";
import type { MediaKind, SearchHit } from "./types";

const TMDB = "https://api.themoviedb.org/3";

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

function toHit(item: MediaItem, kind: MediaKind, english?: MediaItem): SearchHit {
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
  };
}

function mergeLocalized(ko: MediaItem[], en: MediaItem[], kind: MediaKind): SearchHit[] {
  const enByID = new Map(en.map((item) => [item.id, item]));
  return ko.map((item) => toHit(item, kind, enByID.get(item.id)));
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

export async function fetchStreamingPopular(region: string, limit = 10): Promise<SearchHit[]> {
  const base = {
    language: "ko-KR",
    watch_region: region,
    sort_by: "popularity.desc",
    page: "1",
    with_watch_monetization_types: "flatrate|free|ads",
  };
  const [koMovies, koTV, enMovies, enTV] = await Promise.all([
    tmdb<{ results: MediaItem[] }>("/discover/movie", base),
    tmdb<{ results: MediaItem[] }>("/discover/tv", base),
    tmdb<{ results: MediaItem[] }>("/discover/movie", { ...base, language: "en-US" }),
    tmdb<{ results: MediaItem[] }>("/discover/tv", { ...base, language: "en-US" }),
  ]);
  const hits = [
    ...mergeLocalized(koMovies.results ?? [], enMovies.results ?? [], "movie"),
    ...mergeLocalized(koTV.results ?? [], enTV.results ?? [], "tv"),
  ]
    .sort((a, b) => b.voteCount - a.voteCount || b.voteAverage - a.voteAverage)
    .slice(0, limit);
  return hits;
}

export async function enrichPrimaryProvider(hits: SearchHit[], region: string): Promise<SearchHit[]> {
  return Promise.all(hits.map(async (hit) => {
    try {
      const data = await tmdb<{
        results?: Record<string, { flatrate?: ProviderDTO[]; free?: ProviderDTO[]; ads?: ProviderDTO[] }>;
      }>(`/${hit.kind}/${hit.tmdbID}/watch/providers`);
      const country = data.results?.[region];
      const provider = country?.flatrate?.[0] ?? country?.free?.[0] ?? country?.ads?.[0];
      if (!provider) return hit;
      return {
        ...hit,
        providerLogo: provider.logo_path,
        providerName: provider.provider_name,
      };
    } catch {
      return hit;
    }
  }));
}

export async function loadRecommendations(region: string): Promise<{ trending: SearchHit[]; streaming: SearchHit[] }> {
  const [trendingRaw, streamingRaw] = await Promise.all([
    fetchTrending(10),
    fetchStreamingPopular(region, 10),
  ]);
  const [trending, streaming] = await Promise.all([
    enrichPrimaryProvider(trendingRaw, region),
    enrichPrimaryProvider(streamingRaw, region),
  ]);
  return { trending, streaming };
}
