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

export const RECOMMEND_BUNDLE_TTL_MS = 4 * 60 * 60 * 1000;

export function clearRecommendBundleCache(): void {
  cachedBundle = undefined;
  cachedRegion = undefined;
  inflight = undefined;
}

export function recommendBundleFresh(bundle: RecommendBundle, maxAgeMs = RECOMMEND_BUNDLE_TTL_MS): boolean {
  const generated = Date.parse(bundle.generatedAt);
  if (Number.isNaN(generated)) return false;
  return Date.now() - generated < maxAgeMs;
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
