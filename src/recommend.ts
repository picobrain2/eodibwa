import { fetchMotnProviderHits, invalidateMotnCache, MOTN_TMDB_PROVIDER, prefetchMotnRegion } from "./motn";
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
const CHART_TTL_MS = 30 * 60 * 1000;
const CHART_SIZE = 36;
const BATCH_SIZE = 6;

const catalogCache = new Map<string, { map: Map<number, { name: string; logo?: string }>; expires: number }>();

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
  genre_ids?: number[];
}

interface ProviderDTO {
  provider_id: number;
  provider_name: string;
  logo_path?: string;
}

interface TrendingRow {
  item: MediaItem;
  kind: MediaKind;
  rank: number;
  english?: MediaItem;
}

interface ChartEntry {
  hit: SearchHit;
  kind: MediaKind;
  rank: number;
  genreIDs: number[];
  providerIDs: Set<number>;
}

interface ChartCache {
  region: string;
  entries: ChartEntry[];
  expires: number;
}

let chartCache: ChartCache | undefined;

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

function matchesGenre(genreIDs: number[], kind: MediaKind, genre?: RecommendGenre): boolean {
  if (!genre) return true;
  const target = kind === "movie" ? genre.movieID : genre.tvID;
  if (!target) return true;
  return genreIDs.includes(target);
}

export function invalidateRecommendChart(): void {
  chartCache = undefined;
  invalidateMotnCache();
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

async function fetchCombinedTrending(limit = CHART_SIZE): Promise<TrendingRow[]> {
  const [koDay, enDay, koWeek, enWeek] = await Promise.all([
    tmdb<{ results: MediaItem[] }>("/trending/all/day", { language: "ko-KR" }),
    tmdb<{ results: MediaItem[] }>("/trending/all/day", { language: "en-US" }),
    tmdb<{ results: MediaItem[] }>("/trending/all/week", { language: "ko-KR" }),
    tmdb<{ results: MediaItem[] }>("/trending/all/week", { language: "en-US" }),
  ]);

  const enByKey = new Map<string, MediaItem>();
  for (const list of [enDay.results ?? [], enWeek.results ?? []]) {
    for (const item of list) {
      if (item.media_type !== "movie" && item.media_type !== "tv") continue;
      enByKey.set(`${item.media_type}-${item.id}`, item);
    }
  }

  const rows: TrendingRow[] = [];
  const seen = new Set<string>();
  let rank = 0;

  for (const source of [koDay.results ?? [], koWeek.results ?? []]) {
    for (const item of source) {
      const kind = item.media_type === "movie" || item.media_type === "tv" ? item.media_type : undefined;
      if (!kind) continue;
      const key = `${kind}-${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ item, kind, rank: rank++, english: enByKey.get(key) });
      if (rows.length >= limit) return rows;
    }
  }

  return rows;
}

async function fetchProviderIDs(kind: MediaKind, id: number, region: string): Promise<number[]> {
  const data = await tmdb<{
    results?: Record<string, {
      flatrate?: ProviderDTO[];
      free?: ProviderDTO[];
      ads?: ProviderDTO[];
    }>;
  }>(`/${kind}/${id}/watch/providers`, { watch_region: region });

  const country = data.results?.[region];
  if (!country) return [];

  const ids = new Set<number>();
  for (const list of [country.flatrate, country.free, country.ads]) {
    for (const provider of list ?? []) ids.add(provider.provider_id);
  }
  return [...ids];
}

async function mapInBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    const batch = items.slice(index, index + size);
    out.push(...await Promise.all(batch.map(fn)));
  }
  return out;
}

async function buildTrendingChart(region: string): Promise<ChartEntry[]> {
  if (chartCache && chartCache.region === region && chartCache.expires > Date.now()) {
    return chartCache.entries;
  }

  const trending = await fetchCombinedTrending();
  const tracked = new Set(PROVIDER_IDS[region] ?? PROVIDER_IDS.KR);

  const entries = await mapInBatches(trending, BATCH_SIZE, async (row) => {
    const providerIDs = new Set(
      (await fetchProviderIDs(row.kind, row.item.id, region)).filter((id) => tracked.has(id)),
    );
    return {
      hit: toHit(row.item, row.kind, row.english),
      kind: row.kind,
      rank: row.rank,
      genreIDs: row.item.genre_ids ?? [],
      providerIDs,
    } satisfies ChartEntry;
  });

  chartCache = { region, entries, expires: Date.now() + CHART_TTL_MS };
  return entries;
}

function projectSingleProvider(
  entries: ChartEntry[],
  catalog: Map<number, { name: string; logo?: string }>,
  genre: RecommendGenre | undefined,
  providerID: number,
  limit = 8,
): SearchHit[] {
  const meta = catalog.get(providerID) ?? { name: `Provider ${providerID}` };
  const filtered = entries.filter((entry) => matchesGenre(entry.genreIDs, entry.kind, genre));
  return filtered
    .filter((entry) => entry.providerIDs.has(providerID))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((entry) => ({
      ...entry.hit,
      providerLogo: meta.logo,
      providerName: meta.name,
      providerID,
    }));
}

export async function fetchProviderRecommendations(region: string, genreID = 0): Promise<RecommendProvider[]> {
  const genre = genreID === 0 ? undefined : RECOMMEND_GENRES.find((item) => item.id === genreID);
  const catalog = await providerCatalog(region);
  const ids = PROVIDER_IDS[region] ?? PROVIDER_IDS.KR;

  const needsTmdb = ids.some((id) => !settings.hasMOTN || !MOTN_TMDB_PROVIDER[id]);
  const motnPrefetch = settings.hasMOTN ? prefetchMotnRegion(region) : Promise.resolve();
  const tmdbChart = needsTmdb ? buildTrendingChart(region) : Promise.resolve([] as ChartEntry[]);
  const [entries] = await Promise.all([tmdbChart, motnPrefetch]);

  const rows = await Promise.all(
    ids.map(async (id) => {
      const meta = catalog.get(id) ?? { name: `Provider ${id}` };
      const provider = { id, name: meta.name, logo: meta.logo };
      const motnService = settings.hasMOTN ? MOTN_TMDB_PROVIDER[id] : undefined;

      if (motnService) {
        try {
          const hits = await fetchMotnProviderHits(region, motnService, provider, genre);
          if (hits.length) return { id, name: meta.name, logo: meta.logo, hits } as RecommendProvider;
        } catch {
          // fall back to TMDB for this provider
        }
      }

      const hits = projectSingleProvider(entries, catalog, genre, id);
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
