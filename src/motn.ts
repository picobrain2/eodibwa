import { settings } from "./settings";
import type { RecommendGenre } from "./recommend";
import type { MediaKind, SearchHit } from "./types";

const BASE = "https://api.movieofthenight.com/v4";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STORAGE_KEY = "eodibwa.motnCache.v1";

export const MOTN_TMDB_PROVIDER: Record<number, string> = {
  8: "netflix",
  337: "disney",
  119: "prime",
  350: "apple",
};

const MOTN_GENRE_NAMES: Record<number, string> = {
  1: "Action",
  2: "Comedy",
  3: "Drama",
  4: "Science Fiction",
  5: "Horror",
  6: "Romance",
  7: "Animation",
  8: "Documentary",
  9: "Thriller",
  10: "Fantasy",
  11: "Crime",
};

interface MOTNGenre {
  id: string;
  name: string;
}

export interface MOTNShow {
  showType?: "movie" | "series";
  tmdbId?: string;
  title?: string;
  originalTitle?: string;
  overview?: string;
  releaseYear?: number;
  firstAirYear?: number;
  rating?: number;
  genres?: MOTNGenre[];
  imageSet?: {
    verticalPoster?: Record<string, string>;
  };
}

interface MotnRegionCache {
  region: string;
  fetchedAt: number;
  tops: Record<string, MOTNShow[]>;
}

let memoryCache: MotnRegionCache | undefined;
let inflight: Promise<MotnRegionCache> | undefined;
let inflightRegion = "";

function normalizeShows(payload: unknown): MOTNShow[] {
  if (Array.isArray(payload)) return payload as MOTNShow[];
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.shows)) return record.shows as MOTNShow[];
    if (Array.isArray(record.results)) return record.results as MOTNShow[];
  }
  return [];
}

function readTmdbId(show: MOTNShow & Record<string, unknown>): string | undefined {
  const raw = show.tmdbId ?? show.tmdb_id ?? show.tmdbID;
  return typeof raw === "string" && raw.includes("/") ? raw : undefined;
}

async function motn<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const key = settings.motn;
  if (!key) throw new Error("Movie of the Night API 키가 필요합니다.");
  const url = new URL(`${BASE}${path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-API-Key": key,
    },
  });
  if (response.status === 401) throw new Error("Movie of the Night API 키가 올바르지 않습니다.");
  if (!response.ok) throw new Error(`Movie of the Night API ${response.status}`);
  return response.json() as Promise<T>;
}

export async function pingMOTN(): Promise<void> {
  await motn("/countries");
}

function readPersisted(): MotnRegionCache | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw) as MotnRegionCache;
  } catch {
    return undefined;
  }
}

function writePersisted(cache: MotnRegionCache): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // storage full or unavailable
  }
}

function isFresh(cache: MotnRegionCache, region: string): boolean {
  return cache.region === region && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

function totalShows(cache: MotnRegionCache): number {
  return Object.values(cache.tops).reduce((sum, list) => sum + list.length, 0);
}

export function invalidateMotnCache(): void {
  memoryCache = undefined;
  inflight = undefined;
  inflightRegion = "";
  localStorage.removeItem(STORAGE_KEY);
}

export function motnCacheFresh(region: string): boolean {
  const cache = memoryCache ?? readPersisted();
  return Boolean(cache && isFresh(cache, region) && totalShows(cache) > 0);
}

async function fetchFreshRegionCache(region: string): Promise<MotnRegionCache> {
  const country = region.toLowerCase();
  const services = [...new Set(Object.values(MOTN_TMDB_PROVIDER))];
  const tops: Record<string, MOTNShow[]> = {};

  const results = await Promise.allSettled(
    services.map(async (service) => {
      const payload = await motn<unknown>("/shows/top", {
        country,
        service,
        output_language: "ko",
      });
      tops[service] = normalizeShows(payload);
    }),
  );

  const failed = results.filter((result) => result.status === "rejected").length;
  const count = Object.values(tops).reduce((sum, list) => sum + list.length, 0);
  if (count === 0) {
    const reason = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    throw reason?.reason ?? new Error("Movie of the Night에서 Top 10을 가져오지 못했습니다.");
  }
  if (failed > 0) {
    console.warn(`MOTN: ${failed}/${services.length} OTT Top 10 요청 실패`);
  }

  const cache: MotnRegionCache = { region, fetchedAt: Date.now(), tops };
  memoryCache = cache;
  writePersisted(cache);
  return cache;
}

async function ensureRegionCache(region: string): Promise<MotnRegionCache> {
  if (memoryCache && isFresh(memoryCache, region) && totalShows(memoryCache) > 0) {
    return memoryCache;
  }

  const persisted = readPersisted();
  if (persisted && isFresh(persisted, region) && totalShows(persisted) > 0) {
    memoryCache = persisted;
    return persisted;
  }

  if (inflight && inflightRegion === region) return inflight;

  inflightRegion = region;
  inflight = fetchFreshRegionCache(region).finally(() => {
    inflight = undefined;
    inflightRegion = "";
  });
  return inflight;
}

function posterFrom(show: MOTNShow): string | undefined {
  const posters = show.imageSet?.verticalPoster;
  if (!posters) return undefined;
  return posters.w360 ?? posters.w480 ?? posters.w240 ?? Object.values(posters)[0];
}

function parseTmdb(show: MOTNShow): { kind: MediaKind; id: number } | undefined {
  const raw = readTmdbId(show as MOTNShow & Record<string, unknown>);
  if (!raw) return undefined;
  const [type, idText] = raw.split("/");
  const id = Number(idText);
  if (!id) return undefined;
  if (type === "movie") return { kind: "movie", id };
  if (type === "tv" || type === "series") return { kind: "tv", id };
  return undefined;
}

export function motnShowToHit(
  show: MOTNShow,
  provider: { id: number; name: string; logo?: string },
): SearchHit | undefined {
  const parsed = parseTmdb(show);
  if (!parsed) return undefined;
  const kind: MediaKind = show.showType === "movie" ? "movie" : "tv";
  const year = show.releaseYear ?? show.firstAirYear;
  return {
    id: `${kind}-${parsed.id}`,
    tmdbID: parsed.id,
    kind,
    titleKO: show.title ?? show.originalTitle ?? "",
    titleEN: show.originalTitle ?? show.title ?? "",
    year: year ? String(year) : undefined,
    overview: show.overview ?? "",
    posterPath: posterFrom(show),
    voteAverage: (show.rating ?? 0) / 10,
    voteCount: 0,
    providerLogo: provider.logo,
    providerName: provider.name,
    providerID: provider.id,
  };
}

function matchesGenre(show: MOTNShow, genre: RecommendGenre): boolean {
  const label = MOTN_GENRE_NAMES[genre.id]?.toLowerCase();
  if (!label) return true;
  return (show.genres ?? []).some((item) => item.name.toLowerCase().includes(label));
}

export async function fetchMotnProviderHits(
  region: string,
  service: string,
  provider: { id: number; name: string; logo?: string },
  genre?: RecommendGenre,
  limit = 8,
): Promise<SearchHit[]> {
  const cache = await ensureRegionCache(region);
  return (cache.tops[service] ?? [])
    .filter((show) => (genre ? matchesGenre(show, genre) : true))
    .slice(0, limit)
    .map((show) => motnShowToHit(show, provider))
    .filter((hit): hit is SearchHit => Boolean(hit));
}

export async function prefetchMotnRegion(region: string): Promise<boolean> {
  if (!settings.hasMOTN) return false;
  try {
    await ensureRegionCache(region);
    return true;
  } catch {
    return false;
  }
}
