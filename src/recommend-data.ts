import type { RecommendProvider } from "./recommend";
import type { SearchHit } from "./types";

export interface RecommendBundle {
  generatedAt: string;
  region: string;
  trending: SearchHit[];
  genres: Record<string, RecommendProvider[]>;
}

let cachedBundle: RecommendBundle | undefined;
let cachedRegion: string | undefined;
let inflight: Promise<RecommendBundle | null> | undefined;

export const RECOMMEND_BUNDLE_TTL_KR_MS = 12 * 60 * 60 * 1000;
export const RECOMMEND_BUNDLE_TTL_OVERSEAS_MS = 24 * 60 * 60 * 1000;
/** @deprecated use recommendBundleTTL(region) */
export const RECOMMEND_BUNDLE_TTL_MS = RECOMMEND_BUNDLE_TTL_KR_MS;

export function recommendBundleTTL(region: string): number {
  return region === "KR" ? RECOMMEND_BUNDLE_TTL_KR_MS : RECOMMEND_BUNDLE_TTL_OVERSEAS_MS;
}

export function clearRecommendBundleCache(): void {
  cachedBundle = undefined;
  cachedRegion = undefined;
  inflight = undefined;
}

export function recommendBundleFresh(bundle: RecommendBundle, maxAgeMs?: number): boolean {
  const generated = Date.parse(bundle.generatedAt);
  if (Number.isNaN(generated)) return false;
  const ttl = maxAgeMs ?? recommendBundleTTL(bundle.region);
  return Date.now() - generated < ttl;
}

export function providersForGenre(bundle: RecommendBundle, genreID: number): RecommendProvider[] {
  if (genreID === 0) return bundle.genres["0"] ?? [];
  return bundle.genres[String(genreID)] ?? [];
}

async function fetchRecommendBundle(region: string): Promise<RecommendBundle | null> {
  const response = await fetch(`./data/recommendations-${region}.json`, { cache: "no-cache" });
  if (!response.ok) return null;
  const bundle = await response.json() as RecommendBundle;
  if (bundle.region !== region || !bundle.genres) return null;
  return bundle;
}

export async function getRecommendBundle(region: string): Promise<RecommendBundle | null> {
  if (cachedBundle && cachedRegion === region) return cachedBundle;
  if (inflight) return inflight;

  inflight = fetchRecommendBundle(region)
    .then((bundle) => {
      if (bundle) {
        cachedBundle = bundle;
        cachedRegion = region;
      }
      return bundle;
    })
    .finally(() => {
      inflight = undefined;
    });

  return inflight;
}
