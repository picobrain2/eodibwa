import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./setup-node.ts";
import {
  invalidateRecommendChart,
  loadRecommendations,
  RECOMMEND_GENRES,
  RECOMMEND_REGIONS,
  type RecommendProvider,
} from "../src/recommend.ts";
import type { SearchHit } from "../src/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "data");
const DEFAULT_BUNDLE_BASE_URL = "https://picobrain2.github.io/eodibwa";

function parseTargetRegions(): string[] {
  const raw = process.env.PREGENERATE_REGIONS?.split(",").map((item) => item.trim()).filter(Boolean);
  if (!raw?.length) return [...RECOMMEND_REGIONS];
  const unknown = raw.filter((region) => !RECOMMEND_REGIONS.includes(region));
  if (unknown.length) {
    console.warn(`pregenerate: unknown regions skipped: ${unknown.join(", ")}`);
  }
  return raw.filter((region) => RECOMMEND_REGIONS.includes(region));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchExistingBundles(baseUrl: string, regions: string[]): Promise<void> {
  if (!regions.length) return;

  const normalizedBase = baseUrl.replace(/\/$/, "");
  for (const region of regions) {
    const path = join(outDir, `recommendations-${region}.json`);
    if (await fileExists(path)) {
      console.log(`  keep existing ${path}`);
      continue;
    }

    const url = `${normalizedBase}/data/recommendations-${region}.json`;
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) {
        console.warn(`  merge skip ${region}: ${response.status} ${url}`);
        continue;
      }
      const bundle = await response.json() as RecommendBundle;
      if (bundle.region !== region || !bundle.genres) {
        console.warn(`  merge skip ${region}: invalid bundle shape`);
        continue;
      }
      await writeFile(path, JSON.stringify(bundle));
      console.log(`  merged ${path} from ${url}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  merge skip ${region}: ${message}`);
    }
  }
}

interface RecommendBundle {
  generatedAt: string;
  region: string;
  trending: SearchHit[];
  genres: Record<string, RecommendProvider[]>;
}

async function generateRegion(region: string): Promise<RecommendBundle> {
  invalidateRecommendChart();
  const genres: Record<string, RecommendProvider[]> = {};
  let trending: SearchHit[] = [];

  for (const genre of RECOMMEND_GENRES) {
    console.log(`  genre ${genre.name} (${genre.id})`);
    try {
      const data = await loadRecommendations(region, genre.id);
      if (genre.id === 0) trending = data.trending;
      genres[String(genre.id)] = data.providers;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  genre ${genre.name} skipped: ${message}`);
      genres[String(genre.id)] = [];
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return {
    generatedAt: new Date().toISOString(),
    region,
    trending,
    genres,
  };
}

async function main(): Promise<void> {
  if (!process.env.VITE_TMDB_KEY) {
    console.warn("pregenerate: VITE_TMDB_KEY not set — skipping (client will use live API).");
    return;
  }

  await mkdir(outDir, { recursive: true });

  const targetRegions = parseTargetRegions();
  const mergeRegions = RECOMMEND_REGIONS.filter((region) => !targetRegions.includes(region));
  const skipMerge = process.env.PREGENERATE_SKIP_MERGE === "1" || mergeRegions.length === 0;

  if (!skipMerge) {
    const baseUrl = process.env.RECOMMEND_BUNDLE_BASE_URL ?? DEFAULT_BUNDLE_BASE_URL;
    console.log(`pregenerate: merging ${mergeRegions.join(", ")} from ${baseUrl}`);
    await fetchExistingBundles(baseUrl, mergeRegions);
  }

  for (const region of targetRegions) {
    console.log(`Generating recommendations for ${region}…`);
    const bundle = await generateRegion(region);
    const path = join(outDir, `recommendations-${region}.json`);
    await writeFile(path, JSON.stringify(bundle));
    console.log(`  wrote ${path}`);
  }

  console.log("pregenerate: done.");
}

main().catch((err) => {
  console.warn("pregenerate failed — build will continue with existing or live data:", err);
});
