import { settings } from "./settings";

const TMDB = "https://api.themoviedb.org/3";
const TTL_MS = 60 * 60 * 1000;

const cache = new Map<string, { ids: Set<number>; expires: number }>();
const inflight = new Map<string, Promise<Set<number>>>();

async function tmdb<T>(path: string, query: Record<string, string>): Promise<T> {
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

async function fetchNowPlaying(region: string): Promise<Set<number>> {
  const ids = new Set<number>();
  for (let page = 1; page <= 2; page += 1) {
    const data = await tmdb<{ results?: { id: number }[] }>("/movie/now_playing", {
      language: "ko-KR",
      region,
      page: String(page),
    });
    const rows = data.results ?? [];
    for (const item of rows) ids.add(item.id);
    if (rows.length < 20) break;
  }
  return ids;
}

export async function loadNowPlaying(region = settings.region): Promise<Set<number>> {
  const cached = cache.get(region);
  if (cached && cached.expires > Date.now()) return cached.ids;

  let pending = inflight.get(region);
  if (!pending) {
    pending = fetchNowPlaying(region).finally(() => {
      inflight.delete(region);
    });
    inflight.set(region, pending);
  }

  try {
    const ids = await pending;
    cache.set(region, { ids, expires: Date.now() + TTL_MS });
    return ids;
  } catch {
    return cache.get(region)?.ids ?? new Set();
  }
}

export function invalidateNowPlaying(region?: string): void {
  if (region) cache.delete(region);
  else cache.clear();
}
