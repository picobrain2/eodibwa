import { settings } from "./settings";

const KMDB_API = "https://api.koreafilm.or.kr/openapi-data2/wisenut/search_api/search_json2.jsp";

export interface KmdbEntry {
  docId: string;
  title: string;
  titleEng?: string;
  year?: string;
  rating?: string;
  genre?: string;
  plot?: string;
  runtime?: string;
  kmdbURL: string;
  posterURL?: string;
}

interface KmdbResultRow {
  DOCID?: string;
  docid?: string;
  movieId?: string;
  movieSeq?: string;
  title?: string;
  titleEng?: string;
  prodYear?: string;
  rating?: string;
  ratingGrade?: string;
  genre?: string;
  kmdbUrl?: string;
  runtime?: string;
  directors?: { director?: { directorNm?: string }[] | { directorNm?: string } };
  plots?: { plot?: { plotText?: string }[] | { plotText?: string } };
  posters?: string;
}

interface KmdbResponse {
  TotalCount?: number;
  Data?: { Result?: KmdbResultRow[] }[];
}

const lookupCache = new Map<string, KmdbEntry | null>();

function cacheKey(title: string, year?: string): string {
  return `${title}|${year ?? ""}`;
}

function compactQuery(title: string): string {
  return title.replace(/\s+/g, "").trim();
}

function firstDirector(row: KmdbResultRow): string | undefined {
  const group = row.directors?.director;
  if (!group) return undefined;
  const list = Array.isArray(group) ? group : [group];
  return list.map((item) => item.directorNm).find(Boolean);
}

function firstPlot(row: KmdbResultRow): string | undefined {
  const group = row.plots?.plot;
  if (!group) return undefined;
  const list = Array.isArray(group) ? group : [group];
  return list.map((item) => item.plotText?.trim()).find(Boolean);
}

function kmdbURL(row: KmdbResultRow): string | undefined {
  if (row.kmdbUrl) return row.kmdbUrl;
  const seq = row.movieSeq;
  const nation = row.movieId ?? "K";
  if (seq) return `https://www.kmdb.or.kr/db/kor/detail/movie/${nation}/${seq}`;
  return undefined;
}

function toEntry(row: KmdbResultRow): KmdbEntry | null {
  const docId = row.DOCID ?? row.docid;
  const url = kmdbURL(row);
  const title = row.title?.trim();
  if (!docId || !url || !title) return null;
  return {
    docId,
    title,
    titleEng: row.titleEng?.trim() || undefined,
    year: row.prodYear?.trim() || undefined,
    rating: row.ratingGrade?.trim() || row.rating?.trim() || undefined,
    genre: row.genre?.trim() || undefined,
    plot: firstPlot(row),
    runtime: row.runtime?.trim() || undefined,
    kmdbURL: url,
    posterURL: row.posters?.trim() || undefined,
  };
}

function pickBest(rows: KmdbResultRow[], year?: string, director?: string): KmdbEntry | null {
  let best: { entry: KmdbEntry; score: number } | undefined;
  for (const row of rows) {
    const entry = toEntry(row);
    if (!entry) continue;
    let score = 0;
    if (year && entry.year === year) score += 4;
    else if (year && entry.year && Math.abs(Number(entry.year) - Number(year)) <= 1) score += 2;
    if (director && firstDirector(row)?.includes(director.split(",")[0]?.trim() ?? "")) score += 2;
    if (!best || score > best.score) best = { entry, score };
  }
  return best?.entry ?? toEntry(rows[0] ?? {}) ?? null;
}

async function requestKMDB(params: Record<string, string>): Promise<KmdbResultRow[]> {
  const key = settings.kmdb;
  if (!key) return [];

  const url = new URL(KMDB_API);
  url.searchParams.set("collection", "kmdb_new2");
  url.searchParams.set("ServiceKey", key);
  url.searchParams.set("detail", "Y");
  url.searchParams.set("listCount", "10");

  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  try {
    const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) return [];
    const data = await response.json() as KmdbResponse;
    const rows: KmdbResultRow[] = [];
    for (const block of data.Data ?? []) {
      rows.push(...(block.Result ?? []));
    }
    return rows;
  } catch {
    return [];
  }
}

export async function lookupKMDB(
  titleKO: string,
  titleEN: string,
  year?: string,
  director?: string,
): Promise<KmdbEntry | null> {
  if (!settings.hasKMDB) return null;

  const queries = [...new Set([titleKO, titleEN].map(compactQuery).filter(Boolean))];
  if (!queries.length) return null;

  const key = cacheKey(queries[0], year);
  if (lookupCache.has(key)) return lookupCache.get(key) ?? null;

  let rows: KmdbResultRow[] = [];
  for (const query of queries) {
    rows = await requestKMDB({ query });
    if (rows.length) break;
    rows = await requestKMDB({ title: query });
    if (rows.length) break;
  }

  const entry = pickBest(rows, year, director);
  lookupCache.set(key, entry);
  return entry;
}

export function invalidateKmdbCache(): void {
  lookupCache.clear();
}
