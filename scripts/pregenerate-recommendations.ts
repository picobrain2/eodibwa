import { mkdir, writeFile } from "node:fs/promises";
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
    const data = await loadRecommendations(region, genre.id);
    if (genre.id === 0) trending = data.trending;
    genres[String(genre.id)] = data.providers;
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

  for (const region of (process.env.PREGENERATE_REGIONS?.split(",") ?? RECOMMEND_REGIONS)) {
    console.log(`Generating recommendations for ${region}…`);
    const bundle = await generateRegion(region);
    const path = join(outDir, `recommendations-${region}.json`);
    await writeFile(path, JSON.stringify(bundle));
    console.log(`  wrote ${path}`);
  }

  console.log("pregenerate: done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
