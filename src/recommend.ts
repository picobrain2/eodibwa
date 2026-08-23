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
  { id: 12, name: "예능", tvID: 10764 },
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

export const RECOMMEND_REGIONS = Object.keys(PROVIDER_IDS);

/** KR local OTTs — use TMDB discover + watch provider (not network IDs). */
const TMDB_DISCOVER_PROVIDERS = new Set([1883, 356, 97, 1881]);

/** Skip strict KR-origin filter — catalog includes global/licensed titles. */
const RELAXED_ORIGIN_PROVIDERS = new Set([1881]);

const CATALOG_TTL_MS = 60 * 60 * 1000;
const CHART_TTL_MS = 30 * 60 * 1000;
const CHART_SIZE = 20;
const BATCH_SIZE = 6;
const DISPLAY_LIMIT = 8;
const CANDIDATE_LIMIT = 24;
const RECENT_AIR_DAYS = 30;
const RECENT_PREMIERE_DAYS = 180;
const RECENT_MOVIE_DAYS = 90;

/** Major KR broadcasters whose shows stream on TVING. */
const TVING_BROADCAST_NETWORKS = "866|885|813|989|2710";

/** TMDB Reality — Korean variety / unscripted (예능). */
const TV_GENRE_REALITY = 10764;
const TVING_VARIETY_SLOTS = 4;

/** TMDB network for Coupang Play originals (watch provider link often missing, e.g. SNL 코리아). */
const COUPANG_PLAY_NETWORK = "5169";

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
const providerIdCache = new Map<string, { ids: number[]; expires: number }>();
const PROVIDER_ID_TTL_MS = 60 * 60 * 1000;

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

function mergeUniqueHits(existing: SearchHit[], extra: SearchHit[], limit = DISPLAY_LIMIT): SearchHit[] {
  const seen = new Set(existing.map((hit) => hit.id));
  const out = [...existing];
  for (const hit of extra) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
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
  providerIdCache.clear();
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
  const cacheKey = `${kind}-${id}-${region}`;
  const cached = providerIdCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.ids;

  const data = await tmdb<{
    results?: Record<string, {
      flatrate?: ProviderDTO[];
      free?: ProviderDTO[];
      ads?: ProviderDTO[];
    }>;
  }>(`/${kind}/${id}/watch/providers`, { watch_region: region });

  const country = data.results?.[region];
  if (!country) {
    providerIdCache.set(cacheKey, { ids: [], expires: Date.now() + PROVIDER_ID_TTL_MS });
    return [];
  }

  const ids = new Set<number>();
  for (const list of [country.flatrate, country.free, country.ads]) {
    for (const provider of list ?? []) ids.add(provider.provider_id);
  }
  const result = [...ids];
  providerIdCache.set(cacheKey, { ids: result, expires: Date.now() + PROVIDER_ID_TTL_MS });
  return result;
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

async function fetchDiscoverPages(
  kind: MediaKind,
  query: Record<string, string>,
  pages = 2,
): Promise<{ ko: (MediaItem & { popularity?: number })[]; en: MediaItem[] }> {
  const pageNums = Array.from({ length: pages }, (_, index) => String(index + 1));
  const [koPages, en1] = await Promise.all([
    Promise.all(pageNums.map((page) =>
      tmdb<{ results: (MediaItem & { popularity?: number })[] }>(`/discover/${kind}`, { ...query, page }),
    )),
    tmdb<{ results: MediaItem[] }>(`/discover/${kind}`, { ...query, page: "1", language: "en-US" }),
  ]);

  const merged = new Map<number, MediaItem & { popularity?: number }>();
  for (const page of koPages) {
    for (const item of page.results ?? []) merged.set(item.id, item);
  }

  return { ko: [...merged.values()], en: en1.results ?? [] };
}

function rowsFromDiscover(
  ko: (MediaItem & { popularity?: number })[],
  en: MediaItem[],
  kind: MediaKind,
): DiscoverRow[] {
  const enByID = new Map(en.map((item) => [item.id, item]));
  return ko.map((item) => ({ item, kind, english: enByID.get(item.id) }));
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
  if (region === "KR" && !RELAXED_ORIGIN_PROVIDERS.has(providerID)) query.with_origin_country = "KR";
  const genreID = kind === "movie" ? genre?.movieID : genre?.tvID;
  if (genreID) query.with_genres = String(genreID);
  if (mode === "premiere" && region === "KR" && kind === "tv" && !RELAXED_ORIGIN_PROVIDERS.has(providerID)) {
    query.sort_by = "vote_count.desc";
    query["vote_count.gte"] = "5";
  }
  applyRecentDateFilter(query, kind, mode);

  const { ko, en } = await fetchDiscoverPages(kind, query);
  return rowsFromDiscover(ko, en, kind);
}

function applyVarietyOnAirFilter(query: Record<string, string>): void {
  applyRecentDateFilter(query, "tv", "air", recentDateRange(RECENT_AIR_DAYS));
}

function mergeDiscoverRows(...groups: DiscoverRow[][]): DiscoverRow[] {
  const merged = new Map<number, DiscoverRow>();
  for (const group of groups) {
    for (const row of group) merged.set(row.item.id, row);
  }
  return [...merged.values()];
}

async function fetchCoupangNetworkMedia(
  genre: RecommendGenre | undefined,
): Promise<DiscoverRow[]> {
  const query: Record<string, string> = {
    language: "ko-KR",
    watch_region: "KR",
    with_networks: COUPANG_PLAY_NETWORK,
    sort_by: "popularity.desc",
    page: "1",
  };
  const genreID = genre?.tvID ?? genre?.movieID;
  if (genreID) query.with_genres = String(genreID);
  if (genre?.tvID === TV_GENRE_REALITY) applyVarietyOnAirFilter(query);

  const { ko, en } = await fetchDiscoverPages("tv", query);
  return rowsFromDiscover(ko, en, "tv");
}

async function fetchRelaxedProviderMedia(
  region: string,
  providerID: number,
  genre: RecommendGenre | undefined,
): Promise<DiscoverRow[]> {
  const query: Record<string, string> = {
    language: "ko-KR",
    watch_region: region,
    with_watch_providers: String(providerID),
    with_watch_monetization_types: "flatrate",
    sort_by: "popularity.desc",
    page: "1",
  };
  const genreID = genre?.tvID ?? genre?.movieID;
  if (genreID) query.with_genres = String(genreID);

  const tvQuery = { ...query };
  if (genre?.tvID === TV_GENRE_REALITY) applyVarietyOnAirFilter(tvQuery);

  const [tv, movie, networkRows] = await Promise.all([
    fetchDiscoverPages("tv", tvQuery),
    genre?.tvID && !genre.movieID
      ? Promise.resolve({ ko: [], en: [] })
      : fetchDiscoverPages("movie", query),
    providerID === 1881 && region === "KR"
      ? fetchCoupangNetworkMedia(genre)
      : Promise.resolve([] as DiscoverRow[]),
  ]);

  return mergeDiscoverRows(
    networkRows,
    rowsFromDiscover(tv.ko, tv.en, "tv"),
    rowsFromDiscover(movie.ko, movie.en, "movie"),
  );
}

async function fetchGenreMedia(
  region: string,
  providerID: number,
  genre: RecommendGenre,
  options?: { pages?: number; relaxOrigin?: boolean; relaxVarietyDates?: boolean },
): Promise<DiscoverRow[]> {
  const pages = options?.pages ?? 3;
  const query: Record<string, string> = {
    language: "ko-KR",
    watch_region: region,
    with_watch_providers: String(providerID),
    with_watch_monetization_types: "flatrate",
    sort_by: "popularity.desc",
    page: "1",
  };
  if (region === "KR" && !RELAXED_ORIGIN_PROVIDERS.has(providerID) && !options?.relaxOrigin) {
    query.with_origin_country = "KR";
  }

  const kinds: MediaKind[] = [
    ...(genre.movieID ? (["movie"] as MediaKind[]) : []),
    ...(genre.tvID ? (["tv"] as MediaKind[]) : []),
  ];
  const rows = await Promise.all(kinds.map(async (kind) => {
    const genreID = kind === "movie" ? genre.movieID : genre.tvID;
    if (!genreID) return [] as DiscoverRow[];
    const kindQuery = { ...query, with_genres: String(genreID) };
    if (kind === "tv" && genreID === TV_GENRE_REALITY && !options?.relaxVarietyDates) {
      applyVarietyOnAirFilter(kindQuery);
    }
    const { ko, en } = await fetchDiscoverPages(kind, kindQuery, pages);
    return rowsFromDiscover(ko, en, kind);
  }));

  return rows.flat();
}

async function topUpGenreHits(
  hits: SearchHit[],
  region: string,
  providerID: number,
  provider: { id: number; name: string; logo?: string },
  genre: RecommendGenre,
  entries: ChartEntry[],
  catalog: Map<number, { name: string; logo?: string }>,
): Promise<SearchHit[]> {
  if (hits.length >= DISPLAY_LIMIT) return hits.slice(0, DISPLAY_LIMIT);

  const seen = new Set(hits.map((hit) => hit.id));
  let result = [...hits];

  const appendRows = (rows: DiscoverRow[], sort: "votes" | "popularity" | "preserve" = "votes") => {
    result = mergeUniqueHits(result, rowsToHits(rows, provider, seen, DISPLAY_LIMIT - result.length, sort), DISPLAY_LIMIT);
  };

  appendRows(await fetchGenreMedia(region, providerID, genre, { pages: 4, relaxOrigin: true }));

  if (result.length < DISPLAY_LIMIT && genre.tvID === TV_GENRE_REALITY) {
    appendRows(
      await fetchGenreMedia(region, providerID, genre, { pages: 4, relaxOrigin: true, relaxVarietyDates: true }),
      "popularity",
    );
  }

  if (result.length < DISPLAY_LIMIT && RELAXED_ORIGIN_PROVIDERS.has(providerID)) {
    appendRows(
      await fetchRelaxedProviderMedia(region, providerID, genre),
      genre.tvID === TV_GENRE_REALITY ? "popularity" : "preserve",
    );
  }

  if (result.length < DISPLAY_LIMIT) {
    result = mergeUniqueHits(result, projectSingleProvider(entries, catalog, genre, providerID, DISPLAY_LIMIT), DISPLAY_LIMIT);
  }

  return result.slice(0, DISPLAY_LIMIT);
}

async function fetchTvingVarietyMedia(): Promise<DiscoverRow[]> {
  const query: Record<string, string> = {
    language: "ko-KR",
    watch_region: "KR",
    with_watch_providers: "1883",
    with_watch_monetization_types: "flatrate",
    with_genres: String(TV_GENRE_REALITY),
    with_origin_country: "KR",
    sort_by: "popularity.desc",
    page: "1",
  };
  applyVarietyOnAirFilter(query);

  const { ko, en } = await fetchDiscoverPages("tv", query);
  return rowsFromDiscover(ko, en, "tv");
}

async function fetchTvingBroadcastMedia(
  genre: RecommendGenre | undefined,
): Promise<DiscoverRow[]> {
  const query: Record<string, string> = {
    language: "ko-KR",
    watch_region: "KR",
    with_watch_providers: "1883",
    with_watch_monetization_types: "flatrate",
    with_networks: TVING_BROADCAST_NETWORKS,
    with_origin_country: "KR",
    sort_by: "vote_count.desc",
    "vote_count.gte": "3",
    page: "1",
  };
  const genreID = genre?.tvID;
  if (genreID) query.with_genres = String(genreID);
  applyRecentDateFilter(query, "tv", "premiere");

  const { ko, en } = await fetchDiscoverPages("tv", query);
  return rowsFromDiscover(ko, en, "tv");
}

function rowsToHits(
  rows: DiscoverRow[],
  provider: { id: number; name: string; logo?: string },
  seen: Set<string>,
  limit: number,
  sort: "votes" | "popularity" | "preserve" = "votes",
): SearchHit[] {
  const hits: SearchHit[] = [];
  const ordered = sort === "preserve"
    ? rows
    : rows.sort((a, b) => {
      if (sort === "popularity") {
        return (b.item.popularity ?? 0) - (a.item.popularity ?? 0);
      }
      const left = (b.item.vote_count ?? 0) * 10 + (b.item.popularity ?? 0);
      const right = (a.item.vote_count ?? 0) * 10 + (a.item.popularity ?? 0);
      return left - right;
    });
  for (const row of ordered) {
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

  const hits: SearchHit[] = [];

  if (RELAXED_ORIGIN_PROVIDERS.has(providerID)) {
    const rows = await fetchRelaxedProviderMedia(region, providerID, genre);
    const sort = genre?.tvID === TV_GENRE_REALITY ? "popularity" : "preserve";
    for (const hit of rowsToHits(rows, provider, seen, limit, sort)) {
      hits.push(hit);
      if (hits.length >= limit) return hits;
    }
    return hits;
  }

  if (genre && (genre.tvID || genre.movieID) && !(genre.tvID && genre.movieID)) {
    let rows = await fetchGenreMedia(region, providerID, genre);
    for (const hit of rowsToHits(
      rows,
      provider,
      seen,
      limit,
      genre.tvID === TV_GENRE_REALITY ? "popularity" : "votes",
    )) {
      hits.push(hit);
      if (hits.length >= limit) return hits;
    }
    if (hits.length < limit) {
      rows = await fetchGenreMedia(region, providerID, genre, { pages: 4, relaxOrigin: true });
      for (const hit of rowsToHits(
        rows,
        provider,
        seen,
        limit - hits.length,
        genre.tvID === TV_GENRE_REALITY ? "popularity" : "votes",
      )) {
        hits.push(hit);
        if (hits.length >= limit) return hits;
      }
    }
    if (hits.length < limit && genre.tvID === TV_GENRE_REALITY) {
      rows = await fetchGenreMedia(region, providerID, genre, { pages: 4, relaxOrigin: true, relaxVarietyDates: true });
      for (const hit of rowsToHits(rows, provider, seen, limit - hits.length, "popularity")) {
        hits.push(hit);
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  const kinds: MediaKind[] = genre
    ? [
      ...(genre.movieID ? (["movie"] as MediaKind[]) : []),
      ...(genre.tvID ? (["tv"] as MediaKind[]) : []),
    ]
    : ["tv", "movie"];
  const mediaKinds = kinds.length ? kinds : (["tv", "movie"] as MediaKind[]);

  // Variety shows (예능) have very low vote_count on TMDB — fetch separately for TVING "전체".
  if (providerID === 1883 && region === "KR" && !genre) {
    const varietyRows = await fetchTvingVarietyMedia();
    for (const hit of rowsToHits(varietyRows, provider, seen, Math.min(TVING_VARIETY_SLOTS, limit), "popularity")) {
      hits.push(hit);
      if (hits.length >= limit) return hits;
    }
  }

  const tvModes: Array<"premiere" | "air"> = ["premiere", "air"];
  const fetches: Array<{ kind: MediaKind; mode: "premiere" | "air" | "release" }> = [];
  for (const kind of mediaKinds) {
    if (kind === "tv") {
      for (const mode of tvModes) fetches.push({ kind, mode });
    } else {
      fetches.push({ kind, mode: "release" });
    }
  }

  const batches = await Promise.all(
    fetches.map(({ kind, mode }) => fetchDiscoverMedia(kind, region, providerID, genre, mode)),
  );
  for (const rows of batches) {
    for (const hit of rowsToHits(rows, provider, seen, limit - hits.length)) {
      hits.push(hit);
      if (hits.length >= limit) return hits;
    }
  }

  if (providerID === 1883 && region === "KR" && hits.length < limit && (!genre || genre.tvID)) {
    const rows = await fetchTvingBroadcastMedia(genre);
    for (const hit of rowsToHits(rows, provider, seen, limit - hits.length)) {
      hits.push(hit);
      if (hits.length >= limit) return hits;
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
  limit = CANDIDATE_LIMIT,
): Promise<SearchHit[]> {
  const cacheKey = `${region}-${providerID}-${genre?.id ?? 0}-v9`;
  const cached = discoverCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.hits;

  const seen = new Set<string>();
  const hits: SearchHit[] = [];

  // KR OTT: discover first so global trending does not fill slots with cross-platform titles.
  hits.push(...await fetchDiscoverSupplement(region, providerID, provider, genre, seen, limit));

  for (const hit of projectSingleProvider(entries, catalog, genre, providerID, limit)) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    hits.push(hit);
    if (hits.length >= limit) break;
  }

  discoverCache.set(cacheKey, { hits, expires: Date.now() + CHART_TTL_MS });
  return hits;
}

async function dedupeExclusiveProviders(
  providers: RecommendProvider[],
  _region: string,
  _entries: ChartEntry[],
): Promise<RecommendProvider[]> {
  return providers.map((group) => ({
    ...group,
    hits: group.hits.slice(0, DISPLAY_LIMIT),
  }));
}

export async function fetchOneProviderRecommendation(
  region: string,
  providerID: number,
  genreID = 0,
  preloaded?: { entries: ChartEntry[]; catalog: Map<number, { name: string; logo?: string }> },
): Promise<RecommendProvider | null> {
  const genre = genreID === 0 ? undefined : RECOMMEND_GENRES.find((item) => item.id === genreID);
  const catalog = preloaded?.catalog ?? await providerCatalog(region);
  const meta = catalog.get(providerID) ?? { name: `Provider ${providerID}` };
  const provider = { id: providerID, name: meta.name, logo: meta.logo };

  let hits: SearchHit[] = [];
  const motnService = settings.hasMOTN && (await prefetchMotnRegion(region))
    ? MOTN_TMDB_PROVIDER[providerID]
    : undefined;

  if (motnService) {
    try {
      hits = await fetchMotnProviderHits(region, motnService, provider, genre, CANDIDATE_LIMIT);
      if (hits.length && !genre) {
        return { id: providerID, name: meta.name, logo: meta.logo, hits: hits.slice(0, DISPLAY_LIMIT) };
      }
    } catch {
      hits = [];
    }
  }

  const needsChart = !TMDB_DISCOVER_PROVIDERS.has(providerID) || !motnService || Boolean(genre);
  const entries = preloaded?.entries ?? (needsChart ? await buildTrendingChart(region) : []);

  if (TMDB_DISCOVER_PROVIDERS.has(providerID)) {
    const tmdbHits = await fetchProviderPopularHits(region, providerID, provider, genre, entries, catalog);
    hits = mergeUniqueHits(hits, tmdbHits, genre ? DISPLAY_LIMIT : CANDIDATE_LIMIT);
  } else if (needsChart) {
    hits = mergeUniqueHits(
      hits,
      projectSingleProvider(entries, catalog, genre, providerID, CANDIDATE_LIMIT),
      genre ? DISPLAY_LIMIT : CANDIDATE_LIMIT,
    );
  }

  if (genre && hits.length < DISPLAY_LIMIT) {
    hits = await topUpGenreHits(hits, region, providerID, provider, genre, entries, catalog);
  }

  if (!hits.length) return null;
  return { id: providerID, name: meta.name, logo: meta.logo, hits: hits.slice(0, DISPLAY_LIMIT) };
}

export async function refreshProviderGroup(
  region: string,
  providerID: number,
  genreID: number,
  current: RecommendProvider[],
): Promise<RecommendProvider[]> {
  const [entries, catalog] = await Promise.all([buildTrendingChart(region), providerCatalog(region)]);
  const group = await fetchOneProviderRecommendation(region, providerID, genreID, { entries, catalog });
  const merged = current
    .map((item) => (item.id === providerID ? group : item))
    .filter((item): item is RecommendProvider => item !== null);
  return dedupeExclusiveProviders(merged, region, entries);
}

export async function fetchProviderRecommendations(region: string, genreID = 0): Promise<RecommendProvider[]> {
  const catalog = await providerCatalog(region);
  const ids = PROVIDER_IDS[region] ?? PROVIDER_IDS.KR;
  const needsChart = genreID !== 0 || ids.some((id) => !settings.hasMOTN || !MOTN_TMDB_PROVIDER[id]);
  const entries = needsChart ? await buildTrendingChart(region) : [];
  const preloaded = { entries, catalog };

  const rows = await Promise.all(
    ids.map((id) => fetchOneProviderRecommendation(region, id, genreID, preloaded)),
  );
  return dedupeExclusiveProviders(rows.filter((row): row is RecommendProvider => row !== null), region, entries);
}

export async function loadRecommendations(region: string, genreID = 0): Promise<{ trending: SearchHit[]; providers: RecommendProvider[] }> {
  const [trending, providers] = await Promise.all([
    fetchTrending(10),
    fetchProviderRecommendations(region, genreID),
  ]);
  return { trending, providers };
}
