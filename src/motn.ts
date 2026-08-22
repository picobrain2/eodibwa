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

export function invalidateMotnCache(): void {
  memoryCache = undefined;
  inflight = undefined;
  inflightRegion = "";
  localStorage.removeItem(STORAGE_KEY);
}

export function motnCacheAge(region: string): number | undefined {
  const cache = memoryCache ?? readPersisted();
  if (!cache || cache.region !== region) return undefined;
  return Date.now() - cache.fetchedAt;
}

export function motnCacheFresh(region: string): boolean {
  const cache = memoryCache ?? readPersisted();
  return Boolean(cache && isFresh(cache, region));
}

async function fetchFreshRegionCache(region: string): Promise<MotnRegionCache> {
  const country = region.toLowerCase();
  const services = [...new Set(Object.values(MOTN_TMDB_PROVIDER))];
  const tops: Record<string, MOTNShow[]> = {};

  await Promise.all(services.map(async (service) => {
    const top = await motn<MOTNShow[]>("/shows/top", {
      country,
      service,
      output_language: "ko",
    });
    tops[service] = Array.isArray(top) ? top : [];
  }));

  const cache: MotnRegionCache = {
    region,
    fetchedAt: Date.now(),
    tops,
  };
  memoryCache = cache;
  writePersisted(cache);
  return cache;
}

async function ensureRegionCache(region: string): Promise<MotnRegionCache> {
  if (memoryCache && isFresh(memoryCache, region)) return memoryCache;

  const persisted = readPersisted();
  if (persisted && isFresh(persisted, region)) {
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
  if (!show.tmdbId) return undefined;
  const [raw, idText] = show.tmdbId.split("/");
  const id = Number(idText);
  if (!id) return undefined;
  if (raw === "movie") return { kind: "movie", id };
  if (raw === "tv" || raw === "series") return { kind: "tv", id };
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

export async function prefetchMotnRegion(region: string): Promise<void> {
  if (!settings.hasMOTN) return;
  await ensureRegionCache(region);
}
