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
  KR: [8, 1883, 356, 97, 1881, 337, 119, 350],
  US: [8, 337, 350, 119, 384, 531],
  JP: [8, 337, 350, 119, 84],
  TW: [8, 337, 350, 119],
  HK: [8, 337, 350, 119],
  GB: [8, 337, 350, 119, 39],
};

export function regionProviderIDs(region: string): number[] {
  return PROVIDER_IDS[region] ?? PROVIDER_IDS.KR;
}

/** KR local OTTs — use TMDB discover + watch provider (not network IDs). */
const TMDB_DISCOVER_PROVIDERS = new Set([1883, 356, 97, 1881]);

/** Lower = preferred owner when a title is on multiple OTTs (global platforms win over aggregators). */
const PROVIDER_PRIORITY: Record<number, number> = {
  8: 1,
  337: 2,
  119: 3,
  350: 4,
  384: 5,
  531: 6,
  84: 7,
  39: 8,
  1883: 50,
  356: 51,
  97: 52,
  1881: 53,
};

function providerPriority(id: number): number {
  return PROVIDER_PRIORITY[id] ?? 999;
}

function pickExclusiveProvider(providerIDs: number[], tracked: Set<number>): number | undefined {
  let best: number | undefined;
  let bestPriority = Infinity;
  for (const id of providerIDs) {
    if (!tracked.has(id)) continue;
    const priority = providerPriority(id);
    if (priority < bestPriority) {
      bestPriority = priority;
      best = id;
    }
  }
  return best;
}

const CATALOG_TTL_MS = 60 * 60 * 1000;
const CHART_TTL_MS = 30 * 60 * 1000;
const CHART_SIZE = 36;
const BATCH_SIZE = 6;
const RECENT_AIR_DAYS = 30;
const RECENT_PREMIERE_DAYS = 180;
const RECENT_MOVIE_DAYS = 90;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function recentDateRange(days = RECENT_AIR_DAYS): { gte: string; lte: string } {
  const lte = new Date();
  const gte = new Date();
  gte.setDate(gte.getDate() - days);
  return { gte: isoDate(gte), lte: isoDate(lte) };
}

function applyRecentDateFilter(
  query: Record<string, string>,
  kind: MediaKind,
  mode: "air" | "premiere" | "release",
  range = recentDateRange(mode === "premiere" ? RECENT_PREMIERE_DAYS : mode === "release" ? RECENT_MOVIE_DAYS : RECENT_AIR_DAYS),
): void {
  if (kind === "tv") {
    if (mode === "premiere") {
      query["first_air_date.gte"] = range.gte;
      query["first_air_date.lte"] = range.lte;
      return;
    }
    query["air_date.gte"] = range.gte;
    query["air_date.lte"] = range.lte;
    return;
  }
  query["primary_release_date.gte"] = range.gte;
  query["primary_release_date.lte"] = range.lte;
}

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

interface DiscoverRow {
  item: MediaItem & { popularity?: number };
  kind: MediaKind;
  english?: MediaItem;
}

const discoverCache = new Map<string, { hits: SearchHit[]; expires: number }>();

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

export function recentPopularRange(): { gte: string; lte: string } {
  return recentDateRange(RECENT_AIR_DAYS);
}

export function invalidateRecommendChart(): void {
  chartCache = undefined;
  discoverCache.clear();
  invalidateMotnCache();
}

export async function fetchTrending(limit = 10): Promise<SearchHit[]> {
  const rows = await fetchCombinedTrending(Math.max(limit, CHART_SIZE));
  return rows.slice(0, limit).map((row) => toHit(row.item, row.kind, row.english));
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

async function fetchDiscoverMedia(
  kind: MediaKind,
  region: string,
  providerID: number,
  genre: RecommendGenre | undefined,
  mode: "air" | "premiere" | "release",
): Promise<DiscoverRow[]> {
  const query: Record<string, string> = {
    language: "ko-KR",
    watch_region: region,
    with_watch_providers: String(providerID),
    with_watch_monetization_types: "flatrate",
    sort_by: "popularity.desc",
    page: "1",
  };
  if (region === "KR") query.with_origin_country = "KR";
  const genreID = kind === "movie" ? genre?.movieID : genre?.tvID;
  if (genreID) query.with_genres = String(genreID);
  if (mode === "premiere" && region === "KR" && kind === "tv") {
    query.sort_by = "vote_count.desc";
    query["vote_count.gte"] = "5";
  }
  applyRecentDateFilter(query, kind, mode);

  const [ko, en] = await Promise.all([
    tmdb<{ results: (MediaItem & { popularity?: number })[] }>(`/discover/${kind}`, query),
    tmdb<{ results: MediaItem[] }>(`/discover/${kind}`, { ...query, language: "en-US" }),
  ]);

  const enByID = new Map((en.results ?? []).map((item) => [item.id, item]));
  return (ko.results ?? []).map((item) => ({
    item,
    kind,
    english: enByID.get(item.id),
  }));
}

function rowsToHits(
  rows: DiscoverRow[],
  provider: { id: number; name: string; logo?: string },
  seen: Set<string>,
  limit: number,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const row of rows.sort((a, b) => {
    const left = (b.item.vote_count ?? 0) * 10 + (b.item.popularity ?? 0);
    const right = (a.item.vote_count ?? 0) * 10 + (a.item.popularity ?? 0);
    return left - right;
  })) {
    const key = `${row.kind}-${row.item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(toHit(row.item, row.kind, row.english, provider));
    if (hits.length >= limit) break;
  }
  return hits;
}

async function fetchDiscoverSupplement(
  region: string,
  providerID: number,
  provider: { id: number; name: string; logo?: string },
  genre: RecommendGenre | undefined,
  seen: Set<string>,
  limit: number,
): Promise<SearchHit[]> {
  if (limit <= 0) return [];

  const kinds: MediaKind[] = genre
    ? [
      ...(genre.movieID ? (["movie"] as MediaKind[]) : []),
      ...(genre.tvID ? (["tv"] as MediaKind[]) : []),
    ]
    : ["tv", "movie"];
  const mediaKinds = kinds.length ? kinds : (["tv", "movie"] as MediaKind[]);

  const hits: SearchHit[] = [];
  for (const kind of mediaKinds) {
    const modes: Array<"premiere" | "air" | "release"> = kind === "tv" ? ["premiere", "air"] : ["release"];
    for (const mode of modes) {
      const rows = await fetchDiscoverMedia(kind, region, providerID, genre, mode);
      for (const hit of rowsToHits(rows, provider, seen, limit - hits.length)) {
        hits.push(hit);
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

async function fetchProviderPopularHits(
  region: string,
  providerID: number,
  provider: { id: number; name: string; logo?: string },
  genre: RecommendGenre | undefined,
  entries: ChartEntry[],
  catalog: Map<number, { name: string; logo?: string }>,
  limit = 8,
): Promise<SearchHit[]> {
  const cacheKey = `${region}-${providerID}-${genre?.id ?? 0}-v2`;
  const cached = discoverCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.hits;

  const seen = new Set<string>();
  const hits: SearchHit[] = [];

  for (const hit of projectSingleProvider(entries, catalog, genre, providerID, limit)) {
    seen.add(hit.id);
    hits.push(hit);
  }

  if (hits.length < limit) {
    hits.push(...await fetchDiscoverSupplement(region, providerID, provider, genre, seen, limit - hits.length));
  }

  const result = hits.slice(0, limit);
  discoverCache.set(cacheKey, { hits: result, expires: Date.now() + CHART_TTL_MS });
  return result;
}

async function dedupeExclusiveProviders(
  providers: RecommendProvider[],
  region: string,
  entries: ChartEntry[],
): Promise<RecommendProvider[]> {
  const tracked = new Set(PROVIDER_IDS[region] ?? PROVIDER_IDS.KR);
  const entryByHitId = new Map(entries.map((entry) => [entry.hit.id, entry]));
  const providerCache = new Map<string, number[]>();

  const uniqueHits = new Map<string, SearchHit>();
  for (const group of providers) {
    for (const hit of group.hits) uniqueHits.set(hit.id, hit);
  }

  await mapInBatches([...uniqueHits.values()], BATCH_SIZE, async (hit) => {
    const fromChart = entryByHitId.get(hit.id);
    if (fromChart) {
      providerCache.set(hit.id, [...fromChart.providerIDs]);
      return;
    }
    providerCache.set(hit.id, await fetchProviderIDs(hit.kind, hit.tmdbID, region));
  });

  const owner = new Map<string, number>();
  for (const hitId of uniqueHits.keys()) {
    const winner = pickExclusiveProvider(providerCache.get(hitId) ?? [], tracked);
    if (winner !== undefined) owner.set(hitId, winner);
  }

  return providers
    .map((group) => ({
      ...group,
      hits: group.hits.filter((hit) => owner.get(hit.id) === group.id),
    }))
    .filter((group) => group.hits.length > 0);
}

export async function fetchProviderRecommendations(region: string, genreID = 0): Promise<RecommendProvider[]> {
  const genre = genreID === 0 ? undefined : RECOMMEND_GENRES.find((item) => item.id === genreID);
  const catalog = await providerCatalog(region);
  const ids = PROVIDER_IDS[region] ?? PROVIDER_IDS.KR;

  const needsTmdb = ids.some((id) => !settings.hasMOTN || !MOTN_TMDB_PROVIDER[id]);
  const motnReady = settings.hasMOTN ? await prefetchMotnRegion(region) : false;
  const entries = needsTmdb ? await buildTrendingChart(region) : [];

  const rows = await Promise.all(
    ids.map(async (id) => {
      const meta = catalog.get(id) ?? { name: `Provider ${id}` };
      const provider = { id, name: meta.name, logo: meta.logo };
      const motnService = motnReady ? MOTN_TMDB_PROVIDER[id] : undefined;

      if (motnService) {
        try {
          const hits = await fetchMotnProviderHits(region, motnService, provider, genre);
          if (hits.length) return { id, name: meta.name, logo: meta.logo, hits } as RecommendProvider;
        } catch {
          // fall back to TMDB for this provider
        }
      }

      if (TMDB_DISCOVER_PROVIDERS.has(id)) {
        const hits = await fetchProviderPopularHits(region, id, provider, genre, entries, catalog);
        if (hits.length) return { id, name: meta.name, logo: meta.logo, hits } as RecommendProvider;
        return null;
      }

      const hits = projectSingleProvider(entries, catalog, genre, id);
      if (!hits.length) return null;
      return { id, name: meta.name, logo: meta.logo, hits } as RecommendProvider;
    }),
  );

  const filtered = rows.filter((row): row is RecommendProvider => row !== null);
  return dedupeExclusiveProviders(filtered, region, entries);
}

export async function loadRecommendations(region: string, genreID = 0): Promise<{ trending: SearchHit[]; providers: RecommendProvider[] }> {
  const [trending, providers] = await Promise.all([
    fetchTrending(10),
    fetchProviderRecommendations(region, genreID),
  ]);
  return { trending, providers };
}
