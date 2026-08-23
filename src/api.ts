import { lookupKMDB } from "./kmdb";
import { containsHangul, compact, formatCreditRole, formatCrewRole, hangulSpaceVariants, isCrewFocusedDepartment, isLatinOnly, pickEnglish, pickKorean, relevance, searchVariants } from "./lang";
import { settings } from "./settings";
import { loadNowPlaying } from "./theaters";
import type { CastMember, MediaKind, PopularReview, RegionAvailability, SearchHit, TitleDetail, WatchOffer, WatchProvider } from "./types";

const TMDB = "https://api.themoviedb.org/3";

async function tmdb<T>(path: string, query: Record<string, string> = {}, attempt = 0): Promise<T> {
  const key = settings.tmdb;
  if (!key) throw new Error("TMDB API 키가 필요합니다.");
  const url = new URL(`${TMDB}${path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const headers: HeadersInit = { Accept: "application/json" };
  if (key.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${key}`;
  } else {
    url.searchParams.set("api_key", key);
  }
  const response = await fetch(url, { headers });
  if ((response.status === 429 || response.status === 503) && attempt < 5) {
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    const wait = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return tmdb<T>(path, query, attempt + 1);
  }
  if (response.status === 401) throw new Error("TMDB API 키가 올바르지 않습니다.");
  if (!response.ok) throw new Error(`서버가 ${response.status} 오류를 반환했습니다.`);
  return response.json() as Promise<T>;
}

interface SearchItem {
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
}

interface PersonSearchItem {
  id: number;
  name?: string;
  original_name?: string;
  popularity?: number;
  known_for_department?: string;
  known_for?: CreditItem[];
}

interface CreditItem extends SearchItem {
  character?: string;
  job?: string;
}

const PERSON_MATCH_MIN = 60;
const PERSON_CREW_JOBS = new Set([
  "Director",
  "Creator",
  "Co-Director",
  "Producer",
  "Executive Producer",
  "Co-Executive Producer",
  "Writer",
  "Screenplay",
  "Story",
  "Teleplay",
  "Author",
]);
const PERSON_KNOWN_FOR_MIN = 1;
const PERSON_QUERY_ALIASES: Record<string, string[]> = {
  iu: ["아이유"],
};
const STAGE_NAME_PERSON_IDS: Record<string, number> = {
  iu: 1252318,
  하하: 138519,
  나영석: 1697747,
};
const PERSON_FILMOGRAPHY_LIMIT = 24;
const PERSON_CACHE_TTL_MS = 30 * 60 * 1000;
const personFilmographyCache = new Map<string, { hits: SearchHit[]; expires: number }>();

function personSearchQueries(query: string): string[] {
  const variants = searchVariants(query);
  const aliases = (PERSON_QUERY_ALIASES[compact(query)] ?? []).filter(containsHangul);
  const primary = variants[0] ?? query.trim();
  const merged = [primary];
  if (aliases[0] && !merged.includes(aliases[0])) merged.push(aliases[0]);
  return merged.slice(0, 2);
}

function personMatchQueries(query: string): string[] {
  const trimmed = query.trim();
  const variants = searchVariants(query);
  const aliases = PERSON_QUERY_ALIASES[compact(query)] ?? [];
  return [...new Set([trimmed, ...variants, ...aliases])];
}

function personRankQueries(query: string): string[] {
  const trimmed = query.trim();
  return [...new Set([trimmed, ...searchVariants(query)])];
}

function personMatchMin(query: string): number {
  if (compact(query).length <= 4 && isLatinOnly(query)) return 80;
  return PERSON_MATCH_MIN;
}

function personMatchMinForQueries(queries: string[]): number {
  return Math.min(...queries.map((item) => personMatchMin(item)));
}

function yearOf(item: SearchItem): string | undefined {
  const date = item.release_date || item.first_air_date || "";
  return date.length >= 4 ? date.slice(0, 4) : undefined;
}

function creditMediaKind(item: SearchItem): MediaKind | undefined {
  if (item.media_type === "movie" || item.media_type === "tv") return item.media_type;
  if (item.media_type) return undefined;
  if (item.title || item.original_title) return "movie";
  if ((item.name || item.original_name) && (item.first_air_date || item.release_date)) return "tv";
  return undefined;
}

export function isKnownStageNameQuery(query: string): boolean {
  return Boolean(STAGE_NAME_PERSON_IDS[compact(query)]);
}

export function isPersonSearchTitleNoise(hit: SearchHit, query: string): boolean {
  if (hit.matchedPerson) return false;
  const q = compact(query);
  if (!q) return false;
  const title = compact(hit.titleKO || hit.titleEN);
  if (!title) return false;
  if (title === q && !hit.year && hit.voteCount < 10) return true;
  if (containsHangul(query) && title.startsWith(q) && title.length > q.length) return true;
  return false;
}

function filterPersonSearchTitleNoise(hits: SearchHit[], query: string): SearchHit[] {
  return hits.filter((hit) => !isPersonSearchTitleNoise(hit, query));
}

function searchItemKey(item: SearchItem): string | undefined {
  const kind = creditMediaKind(item);
  return kind && item.id ? `${kind}-${item.id}` : undefined;
}

function toHit(
  item: SearchItem,
  english?: SearchItem,
  extras?: Pick<SearchHit, "matchedPerson" | "matchedPersonNames" | "matchedRole">,
): SearchHit | undefined {
  if (!item.id) return undefined;
  const kind = creditMediaKind(item);
  if (!kind) return undefined;
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
    matchedPerson: extras?.matchedPerson,
    matchedPersonNames: extras?.matchedPersonNames,
    matchedRole: extras?.matchedRole,
  };
}

interface PersonCandidate {
  id: number;
  names: string[];
  popularity: number;
  department?: string;
  knownFor: CreditItem[];
}

function addPersonName(row: PersonCandidate, name?: string): void {
  const trimmed = name?.trim();
  if (trimmed && !row.names.includes(trimmed)) row.names.push(trimmed);
}

function addPersonNames(map: Map<number, PersonCandidate>, person: PersonSearchItem): void {
  const row = map.get(person.id) ?? { id: person.id, names: [], popularity: 0, knownFor: [] };
  row.popularity = Math.max(row.popularity, person.popularity ?? 0);
  if (person.known_for_department) row.department = person.known_for_department;
  addPersonName(row, person.name);
  addPersonName(row, person.original_name);
  if ((person.known_for?.length ?? 0) > row.knownFor.length) {
    row.knownFor = person.known_for ?? [];
  }
  map.set(person.id, row);
}

function personDepartmentRank(department?: string): number {
  if (department === "Directing") return 3;
  if (department === "Production") return 2;
  if (department === "Writing" || department === "Creator") return 2;
  if (department === "Acting") return 0;
  return 1;
}

function comparePersonCandidates(a: { person: PersonCandidate; score: number }, b: { person: PersonCandidate; score: number }): number {
  if (b.score !== a.score) return b.score - a.score;
  const deptDiff = personDepartmentRank(b.person.department) - personDepartmentRank(a.person.department);
  if (deptDiff !== 0) return deptDiff;
  return b.person.popularity - a.person.popularity;
}

async function enrichPersonCandidates(people: PersonCandidate[]): Promise<void> {
  if (!people.length) return;
  const details = await Promise.all(
    people.map((person) => tmdb<{ name?: string; also_known_as?: string[] }>(`/person/${person.id}`, { language: "ko-KR" })),
  );
  for (let index = 0; index < people.length; index++) {
    addPersonName(people[index], details[index].name);
    for (const aka of details[index].also_known_as ?? []) addPersonName(people[index], aka);
  }
}

function personMatchScore(names: string[], queries: string[]): number {
  return Math.max(0, ...queries.map((item) => relevance(names, item)));
}

async function searchPersonPages(queries: string[], languages: string[]): Promise<PersonSearchItem[]> {
  const tasks = queries.flatMap((item) =>
    languages.map((language) =>
      tmdb<{ results: PersonSearchItem[] }>("/search/person", { query: item, language, include_adult: "false", page: "1" }),
    ),
  );
  const pages = await Promise.allSettled(tasks);
  const people: PersonSearchItem[] = [];
  for (const page of pages) {
    if (page.status !== "fulfilled") continue;
    people.push(...page.value.results ?? []);
  }
  return people;
}

function comparePersonFilmographyHits(a: SearchHit, b: SearchHit): number {
  const ratingDiff = b.voteAverage - a.voteAverage;
  if (ratingDiff !== 0) return ratingDiff;
  const yearA = Number.parseInt(a.year ?? "0", 10) || 0;
  const yearB = Number.parseInt(b.year ?? "0", 10) || 0;
  if (yearB !== yearA) return yearB - yearA;
  return popularityVotes(b) - popularityVotes(a);
}

function finalizePersonHits(hits: SearchHit[]): SearchHit[] {
  return hits.sort(comparePersonFilmographyHits).slice(0, PERSON_FILMOGRAPHY_LIMIT);
}

async function fetchPersonFilmographyByID(personID: number): Promise<SearchHit[]> {
  const [detail, credits] = await Promise.all([
    tmdb<{ name?: string; also_known_as?: string[]; known_for_department?: string }>(`/person/${personID}`, { language: "ko-KR" }),
    tmdb<{ cast?: CreditItem[]; crew?: CreditItem[] }>(`/person/${personID}/combined_credits`, { language: "ko-KR" }),
  ]);
  const person: PersonCandidate = {
    id: personID,
    names: [],
    popularity: 100,
    department: detail.known_for_department,
    knownFor: [],
  };
  addPersonName(person, detail.name);
  for (const aka of detail.also_known_as ?? []) addPersonName(person, aka);
  const personName = pickKorean(person.names) || person.names[0] || "";
  const extras = { matchedPerson: personName, matchedPersonNames: person.names };
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  appendPersonCredits(hits, seen, { combined: credits, tv: {} }, extras, isCrewFocusedDepartment(person.department));
  return finalizePersonHits(hits);
}

async function fetchPersonCredits(personID: number): Promise<{ combined: { cast?: CreditItem[]; crew?: CreditItem[] }; tv: { cast?: CreditItem[] } }> {
  try {
    const combined = await tmdb<{ cast?: CreditItem[]; crew?: CreditItem[] }>(`/person/${personID}/combined_credits`, { language: "ko-KR" });
    return { combined, tv: {} };
  } catch {
    return { combined: {}, tv: {} };
  }
}

function appendKnownForCredits(
  hits: SearchHit[],
  seen: Set<string>,
  knownFor: CreditItem[],
  extras: Pick<SearchHit, "matchedPerson" | "matchedPersonNames">,
): void {
  for (const item of knownFor) {
    const hit = toHit(item, undefined, extras);
    if (!hit || seen.has(hit.id)) continue;
    seen.add(hit.id);
    hits.push(hit);
  }
}

function appendPersonCredits(
  hits: SearchHit[],
  seen: Set<string>,
  credits: { combined: { cast?: CreditItem[]; crew?: CreditItem[] }; tv: { cast?: CreditItem[] } },
  extras: Pick<SearchHit, "matchedPerson" | "matchedPersonNames">,
  crewOnly = false,
): void {
  if (!crewOnly) {
    for (const item of credits.combined.cast ?? []) {
      const hit = toHit(item, undefined, { ...extras, matchedRole: formatCreditRole(item.character) });
      if (!hit || seen.has(hit.id)) continue;
      seen.add(hit.id);
      hits.push(hit);
    }

    for (const item of credits.tv.cast ?? []) {
      const hit = toHit(item, undefined, { ...extras, matchedRole: formatCreditRole(item.character) });
      if (!hit || seen.has(hit.id)) continue;
      seen.add(hit.id);
      hits.push(hit);
    }
  }

  for (const item of credits.combined.crew ?? []) {
    if (!item.job || !PERSON_CREW_JOBS.has(item.job)) continue;
    const hit = toHit(item, undefined, { ...extras, matchedRole: formatCrewRole(item.job) });
    if (!hit || seen.has(hit.id)) continue;
    seen.add(hit.id);
    hits.push(hit);
  }
}

async function pickMatchedPerson(query: string): Promise<PersonCandidate | undefined> {
  const matchQueries = personMatchQueries(query);
  const languages = containsHangul(query) ? ["ko-KR"] : ["en-US"];
  const peopleByID = new Map<number, PersonCandidate>();
  for (const person of await searchPersonPages(personSearchQueries(query), languages)) {
    addPersonNames(peopleByID, person);
  }
  if (!peopleByID.size) return undefined;

  const minScore = personMatchMinForQueries(matchQueries);
  const matched = [...peopleByID.values()]
    .map((person) => ({ person, score: personMatchScore(person.names, matchQueries) }))
    .filter((row) => row.score >= minScore)
    .sort(comparePersonCandidates)[0];
  return matched?.person;
}

export async function searchPersonKnownHits(query: string): Promise<SearchHit[]> {
  const cacheKey = compact(query) || query.trim().toLowerCase();
  const cached = personFilmographyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.hits;

  try {
    const knownID = STAGE_NAME_PERSON_IDS[cacheKey];
    if (knownID) {
      const hits = await fetchPersonFilmographyByID(knownID);
      personFilmographyCache.set(cacheKey, { hits, expires: Date.now() + PERSON_CACHE_TTL_MS });
      return hits;
    }

    const person = await pickMatchedPerson(query);
    if (!person || person.knownFor.length < PERSON_KNOWN_FOR_MIN) return [];
    const personName = pickKorean(person.names) || person.names[0] || "";
    const extras = { matchedPerson: personName, matchedPersonNames: person.names };
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    appendKnownForCredits(hits, seen, person.knownFor, extras);
    return finalizePersonHits(hits);
  } catch {
    return [];
  }
}

async function searchPersonFilmography(query: string): Promise<SearchHit[]> {
  const cacheKey = compact(query) || query.trim().toLowerCase();
  const cached = personFilmographyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.hits;

  const rankQueries = personRankQueries(query);
  const matchQueries = personMatchQueries(query);

  try {
    const knownID = STAGE_NAME_PERSON_IDS[cacheKey];
    if (knownID) {
      const hits = await fetchPersonFilmographyByID(knownID);
      personFilmographyCache.set(cacheKey, { hits, expires: Date.now() + PERSON_CACHE_TTL_MS });
      return hits;
    }

    const languages = containsHangul(query) ? ["ko-KR"] : ["en-US"];
    const peopleByID = new Map<number, PersonCandidate>();
    for (const person of await searchPersonPages(personSearchQueries(query), languages)) {
      addPersonNames(peopleByID, person);
    }
    if (!peopleByID.size) return [];

    const minScore = personMatchMinForQueries(matchQueries);
    const matched = [...peopleByID.values()]
      .map((person) => ({ person, score: personMatchScore(person.names, matchQueries) }))
      .filter((row) => row.score >= minScore)
      .sort(comparePersonCandidates)
      .slice(0, 1);

    if (!matched.length) return [];

    const { person } = matched[0];
    if (personMatchScore(person.names, rankQueries) < 80) {
      await enrichPersonCandidates([person]);
    }

    const personName = pickKorean(person.names) || person.names[0] || "";
    const extras = { matchedPerson: personName, matchedPersonNames: person.names };
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const crewOnly = isCrewFocusedDepartment(person.department);

    if (person.knownFor.length) {
      appendKnownForCredits(hits, seen, person.knownFor, extras);
    }

    if (hits.length < 8) {
      appendPersonCredits(hits, seen, await fetchPersonCredits(person.id), extras, crewOnly);
    }

    const finalHits = finalizePersonHits(hits);
    personFilmographyCache.set(cacheKey, { hits: finalHits, expires: Date.now() + PERSON_CACHE_TTL_MS });
    return finalHits;
  } catch {
    return [];
  }
}

function filterShortLatinTitleHits(hits: SearchHit[], query: string): SearchHit[] {
  if (compact(query).length > 4 || !isLatinOnly(query)) return hits;
  return hits.filter((hit) => relevance([hit.titleKO, hit.titleEN], query) >= 80);
}

function filterTitleNoise(hits: SearchHit[], query: string): SearchHit[] {
  const hasFilmography = hits.some((hit) => hit.matchedPerson);
  if (!hasFilmography) return hits;
  const q = compact(query);
  if (q.length <= 4 && (isLatinOnly(query) || containsHangul(query))) {
    return hits.filter((hit) => hit.matchedPerson);
  }
  return filterPersonSearchTitleNoise(hits, query);
}

function compareSearchHits(a: SearchHit, b: SearchHit, query: string): number {
  if (a.matchedPerson && b.matchedPerson) {
    return comparePersonFilmographyHits(a, b);
  }
  const left = searchHitScore(a, query);
  const right = searchHitScore(b, query);
  if (left !== right) return right - left;
  return popularityVotes(b) - popularityVotes(a);
}

function mergeHits(primary: SearchHit[], extra: SearchHit[]): SearchHit[] {
  const byID = new Map<string, SearchHit>();
  for (const hit of primary) byID.set(hit.id, hit);
  for (const hit of extra) {
    const existing = byID.get(hit.id);
    if (!existing) {
      byID.set(hit.id, hit);
      continue;
    }
    if (hit.matchedPerson && !existing.matchedPerson) {
      byID.set(hit.id, {
        ...existing,
        matchedPerson: hit.matchedPerson,
        matchedPersonNames: hit.matchedPersonNames,
        matchedRole: hit.matchedRole,
      });
    }
  }
  return [...byID.values()];
}

function isKoreanHit(hit: SearchHit): boolean {
  if (containsHangul(hit.titleKO)) return true;
  if (hit.matchedPersonNames?.some(containsHangul)) return true;
  if (hit.matchedPerson && containsHangul(hit.matchedPerson)) return true;
  return false;
}

function searchHitScore(hit: SearchHit, query: string): number {
  const titleScore = relevance([hit.titleKO, hit.titleEN], query);
  const personScore = hit.matchedPersonNames
    ? relevance(hit.matchedPersonNames, query)
    : hit.matchedPerson
      ? relevance([hit.matchedPerson], query)
      : 0;
  const fromFilmography = Boolean(hit.matchedPerson);
  const korean = isKoreanHit(hit);
  const votes = popularityVotes(hit);
  const shortQuery = compact(query).length <= 4;

  if (fromFilmography && personScore >= 80 && shortQuery) {
    return 3_000_000 + personScore * 1_000 + (korean ? 50_000 : 0) + votes;
  }
  if (fromFilmography && korean) {
    return 2_000_000 + personScore * 1_000 + titleScore * 10 + votes;
  }
  if (fromFilmography) {
    return 1_000_000 + personScore * 1_000 + titleScore * 10 + votes;
  }
  if (korean && titleScore >= 60) {
    return 100_000 + titleScore * 1_000 + votes;
  }
  if (titleScore >= 80 && shortQuery && isLatinOnly(query) && !korean) {
    return 500 + votes / 1_000;
  }
  if (titleScore >= 80) {
    return titleScore * 1_000 + votes;
  }
  return titleScore * 10 + votes / 1_000;
}

async function searchOnce(query: string): Promise<SearchHit[]> {
  const [ko, en] = await Promise.all([
    tmdb<{ results: SearchItem[] }>("/search/multi", { query, language: "ko-KR", include_adult: "false", page: "1" }),
    tmdb<{ results: SearchItem[] }>("/search/multi", { query, language: "en-US", include_adult: "false", page: "1" }),
  ]);
  const enByID = new Map<string, SearchItem>();
  for (const item of en.results) {
    const key = searchItemKey(item);
    if (key) enByID.set(key, item);
  }
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const item of [...ko.results, ...en.results]) {
    if (item.media_type !== "movie" && item.media_type !== "tv") continue;
    const key = searchItemKey(item);
    if (!key || seen.has(key)) continue;
    const hit = toHit(item, enByID.get(key));
    if (!hit) continue;
    seen.add(hit.id);
    hits.push(hit);
  }
  return hits;
}

async function collect(queries: string[]): Promise<SearchHit[]> {
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  const pages = await Promise.all(queries.map((query) => searchOnce(query)));
  for (const page of pages) {
    for (const hit of page) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      hits.push(hit);
    }
  }
  return hits;
}

export async function pingTMDB(): Promise<void> {
  await tmdb("/configuration");
}

interface TitleLocaleDTO {
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string;
}

interface LocalizedTitles {
  titleKO: string;
  titleEN: string;
  overview?: string;
  posterPath?: string;
}

const localizedTitleCache = new Map<string, LocalizedTitles>();
const externalIdCache = new Map<string, string>();
const omdbVoteCache = new Map<string, { votes: number; expires: number }>();
const LOCALIZE_BATCH = 6;
const ENRICH_BATCH = 6;
const ENRICH_LIMIT = 16;
const OMDB_VOTE_TTL_MS = 24 * 60 * 60 * 1000;

function popularityVotes(hit: SearchHit): number {
  return hit.imdbVoteCount ?? hit.voteCount;
}

async function mapInBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(...await Promise.all(items.slice(index, index + size).map(fn)));
  }
  return out;
}

async function fetchImdbId(kind: MediaKind, tmdbID: number): Promise<string | undefined> {
  const key = `${kind}-${tmdbID}`;
  if (externalIdCache.has(key)) {
    const cached = externalIdCache.get(key);
    return cached ? cached : undefined;
  }
  try {
    const data = await tmdb<{ imdb_id?: string | null }>(`/${kind}/${tmdbID}/external_ids`);
    const imdbID = data.imdb_id?.trim() ?? "";
    externalIdCache.set(key, imdbID);
    return imdbID || undefined;
  } catch {
    externalIdCache.set(key, "");
    return undefined;
  }
}

function parseImdbVotes(raw?: string): number | undefined {
  if (!raw) return undefined;
  const votes = Number.parseInt(raw.replace(/,/g, ""), 10);
  return Number.isFinite(votes) ? votes : undefined;
}

async function fetchImdbVoteCount(imdbID: string): Promise<number | undefined> {
  if (!settings.hasOMDb) return undefined;
  const cached = omdbVoteCache.get(imdbID);
  if (cached && cached.expires > Date.now()) return cached.votes;

  try {
    const url = new URL("https://www.omdbapi.com/");
    url.searchParams.set("i", imdbID);
    url.searchParams.set("apikey", settings.omdb);
    const data = await (await fetch(url)).json() as { Response?: string; imdbVotes?: string };
    const votes = data.Response === "True" ? parseImdbVotes(data.imdbVotes) : undefined;
    if (votes !== undefined) {
      omdbVoteCache.set(imdbID, { votes, expires: Date.now() + OMDB_VOTE_TTL_MS });
    }
    return votes;
  } catch {
    return undefined;
  }
}

function sortSearchHits(hits: SearchHit[], query: string): SearchHit[] {
  return [...hits].sort((a, b) => compareSearchHits(a, b, query));
}

async function enrichSearchHitsWithImdb(hits: SearchHit[]): Promise<SearchHit[]> {
  if (!settings.hasOMDb || !hits.length) return hits;

  return mapInBatches(hits, ENRICH_BATCH, async (hit) => {
    if (hit.imdbVoteCount !== undefined) return hit;

    const imdbID = hit.imdbID ?? await fetchImdbId(hit.kind, hit.tmdbID);
    if (!imdbID) return hit;

    const cached = omdbVoteCache.get(imdbID);
    if (cached && cached.expires > Date.now()) {
      return { ...hit, imdbID, imdbVoteCount: cached.votes };
    }

    const imdbVoteCount = await fetchImdbVoteCount(imdbID);
    if (imdbVoteCount === undefined) return { ...hit, imdbID };
    return { ...hit, imdbID, imdbVoteCount };
  });
}

export async function refineSearchWithImdb(hits: SearchHit[], query: string): Promise<SearchHit[]> {
  if (!settings.hasOMDb || !hits.length) return hits;

  const preliminary = sortSearchHits(hits, query);
  const enrichedTop = await enrichSearchHitsWithImdb(preliminary.slice(0, ENRICH_LIMIT));
  const enrichedByID = new Map(enrichedTop.map((hit) => [hit.id, hit]));
  const merged = preliminary.map((hit) => enrichedByID.get(hit.id) ?? hit);
  return sortSearchHits(merged, query);
}

async function fetchLocalizedTitles(kind: MediaKind, id: number): Promise<LocalizedTitles> {
  const cacheKey = `${kind}-${id}`;
  const cached = localizedTitleCache.get(cacheKey);
  if (cached) return cached;

  const [ko, en] = await Promise.all([
    tmdb<TitleLocaleDTO>(`/${kind}/${id}`, { language: "ko-KR" }),
    tmdb<TitleLocaleDTO>(`/${kind}/${id}`, { language: "en-US" }),
  ]);
  const localized = ko.title || ko.name || "";
  const original = ko.original_title || ko.original_name || "";
  const enLocalized = en.title || en.name || "";
  const enOriginal = en.original_title || en.original_name || "";
  const result: LocalizedTitles = {
    titleKO: pickKorean([localized, original, enLocalized, enOriginal]),
    titleEN: pickEnglish([enLocalized, enOriginal, original, localized]),
    overview: ko.overview || en.overview,
    posterPath: ko.poster_path || en.poster_path,
  };
  localizedTitleCache.set(cacheKey, result);
  return result;
}

export async function localizeHitTitles(hits: SearchHit[]): Promise<SearchHit[]> {
  if (!hits.length || !settings.hasTMDB) return hits;

  const unique = [...new Map(hits.map((hit) => [hit.id, hit])).values()];
  const pending = unique.filter((hit) => {
    if (localizedTitleCache.has(hit.id)) return false;
    if (hit.matchedPerson && containsHangul(hit.titleKO)) return false;
    return true;
  });

  for (let index = 0; index < pending.length; index += LOCALIZE_BATCH) {
    const batch = pending.slice(index, index + LOCALIZE_BATCH);
    await Promise.allSettled(batch.map((hit) => fetchLocalizedTitles(hit.kind, hit.tmdbID)));
  }

  return hits.map((hit) => {
    const loc = localizedTitleCache.get(hit.id);
    if (!loc) return hit;
    return {
      ...hit,
      titleKO: pickKorean([loc.titleKO, hit.titleKO, hit.titleEN]),
      titleEN: pickEnglish([loc.titleEN, hit.titleEN, hit.titleKO]),
      overview: loc.overview || hit.overview,
      posterPath: hit.posterPath || loc.posterPath,
    };
  });
}

function titleSearchVariants(query: string): string[] {
  const key = compact(query);
  const variants = searchVariants(query);
  const titleVariants = [...variants];
  if (isKnownStageNameQuery(query)) {
    return titleVariants;
  }
  for (const extra of hangulSpaceVariants(query)) {
    if (!titleVariants.includes(extra)) titleVariants.push(extra);
  }
  for (const alias of (PERSON_QUERY_ALIASES[key] ?? []).filter(containsHangul)) {
    if (!titleVariants.includes(alias)) titleVariants.push(alias);
  }
  return titleVariants;
}

export async function searchTitleHits(query: string): Promise<SearchHit[]> {
  if (isKnownStageNameQuery(query)) return [];
  const hits = sortSearchHits(
    filterPersonSearchTitleNoise(
      filterShortLatinTitleHits(await collect(titleSearchVariants(query)), query),
      query,
    ),
    query,
  );
  return localizeHitTitles(hits);
}

export async function searchPersonHits(query: string): Promise<SearchHit[]> {
  return searchPersonFilmography(query);
}

export function mergeSearchResults(titleHits: SearchHit[], personHits: SearchHit[], query: string): SearchHit[] {
  return filterTitleNoise(sortSearchHits(mergeHits(titleHits, personHits), query), query);
}

export async function searchTitles(query: string): Promise<SearchHit[]> {
  const [titleHits, personHits] = await Promise.all([
    searchTitleHits(query),
    searchPersonHits(query),
  ]);
  return mergeSearchResults(titleHits, personHits, query);
}

interface ProviderDTO {
  provider_id: number;
  provider_name: string;
  logo_path?: string;
}

interface DetailDTO {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  tagline?: string;
  poster_path?: string;
  release_date?: string;
  first_air_date?: string;
  runtime?: number;
  episode_run_time?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  vote_average?: number;
  vote_count?: number;
  homepage?: string;
  imdb_id?: string;
  genres?: { name?: string }[];
  created_by?: { name?: string }[];
  networks?: { name?: string }[];
  credits?: {
    cast?: { id: number; name?: string; character?: string; profile_path?: string; order?: number }[];
    crew?: { name?: string; job?: string }[];
  };
  external_ids?: { imdb_id?: string };
  "watch/providers"?: {
    results?: Record<string, {
      link?: string;
      flatrate?: ProviderDTO[];
      free?: ProviderDTO[];
      ads?: ProviderDTO[];
      rent?: ProviderDTO[];
      buy?: ProviderDTO[];
    }>;
  };
  release_dates?: { results?: { iso_3166_1: string; release_dates?: { certification?: string }[] }[] };
  content_ratings?: { results?: { iso_3166_1: string; rating?: string }[] };
}

function availability(envelope?: DetailDTO["watch/providers"]): RegionAvailability[] {
  const results = envelope?.results ?? {};
  return Object.entries(results).flatMap(([code, country]) => {
    const providers: WatchProvider[] = [];
    const add = (list: ProviderDTO[] | undefined, offerType: WatchOffer) => {
      for (const item of list ?? []) {
        providers.push({
          providerID: item.provider_id,
          name: item.provider_name,
          logoPath: item.logo_path,
          offerType,
        });
      }
    };
    add(country.flatrate, "flatrate");
    add(country.free, "free");
    add(country.ads, "ads");
    add(country.rent, "rent");
    add(country.buy, "buy");
    if (!providers.length) return [];
    return [{ countryCode: code, justWatchURL: country.link, providers }];
  });
}

function certification(kind: MediaKind, dto: DetailDTO): string | undefined {
  if (kind === "movie") {
    const list = dto.release_dates?.results ?? [];
    const row = list.find((item) => item.iso_3166_1 === "KR") ?? list.find((item) => item.iso_3166_1 === "US");
    return row?.release_dates?.map((item) => item.certification).find((item) => item && item.length > 0);
  }
  const list = dto.content_ratings?.results ?? [];
  const row = list.find((item) => item.iso_3166_1 === "KR") ?? list.find((item) => item.iso_3166_1 === "US");
  return row?.rating || undefined;
}

const detailCache = new Map<string, { detail: TitleDetail; expires: number }>();
const DETAIL_TTL_MS = 30 * 60 * 1000;

function detailCacheKey(kind: MediaKind, id: number): string {
  return `${kind}-${id}`;
}

export async function enrichDetail(detail: TitleDetail): Promise<void> {
  await Promise.all([
    enrichOMDb(detail),
    enrichTVMaze(detail),
    enrichWikipedia(detail),
    enrichKMDB(detail),
  ]);

  if (detail.kind === "movie") {
    const playing = await loadNowPlaying(settings.region);
    detail.inTheaters = playing.has(detail.tmdbID);
  }

  const cached = detailCache.get(detailCacheKey(detail.kind, detail.tmdbID));
  if (cached) cached.detail = { ...detail };
}

export async function fetchDetail(kind: MediaKind, id: number): Promise<TitleDetail> {
  const cacheKey = detailCacheKey(kind, id);
  const cached = detailCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return { ...cached.detail, popularReviews: [...cached.detail.popularReviews] };
  }

  try {
    const detail = await buildDetail(kind, id);
    detailCache.set(cacheKey, { detail: { ...detail }, expires: Date.now() + DETAIL_TTL_MS });
    return { ...detail };
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("404"))) throw err;
    const alt: MediaKind = kind === "movie" ? "tv" : "movie";
    const altKey = detailCacheKey(alt, id);
    const altCached = detailCache.get(altKey);
    if (altCached && altCached.expires > Date.now()) {
      return { ...altCached.detail, popularReviews: [...altCached.detail.popularReviews] };
    }
    const detail = await buildDetail(alt, id);
    detail.kind = alt;
    detail.tmdbURL = `https://www.themoviedb.org/${alt}/${detail.tmdbID}?language=ko-KR`;
    detailCache.set(altKey, { detail: { ...detail }, expires: Date.now() + DETAIL_TTL_MS });
    return { ...detail };
  }
}

async function buildDetail(kind: MediaKind, id: number): Promise<TitleDetail> {
  const append = kind === "movie" ? "watch/providers,external_ids,credits,release_dates" : "watch/providers,external_ids,credits,content_ratings";
  const [koResult, enResult] = await Promise.allSettled([
    tmdb<DetailDTO>(`/${kind}/${id}`, { language: "ko-KR", append_to_response: append }),
    tmdb<DetailDTO>(`/${kind}/${id}`, { language: "en-US" }),
  ]);
  if (koResult.status === "rejected" && enResult.status === "rejected") {
    throw koResult.reason;
  }
  const ko = (koResult.status === "fulfilled"
    ? koResult.value
    : enResult.status === "fulfilled"
      ? enResult.value
      : undefined) as DetailDTO;
  const en = (enResult.status === "fulfilled" ? enResult.value : ko) as DetailDTO;
  const localized = ko.title || ko.name || "";
  const original = ko.original_title || ko.original_name || "";
  const enLocalized = en.title || en.name || "";
  const enOriginal = en.original_title || en.original_name || "";
  const date = ko.release_date || ko.first_air_date || en.release_date || en.first_air_date || "";
  const overview = (ko.overview && ko.overview.length > 0 ? ko.overview : en.overview) ?? "";
  const director = ko.credits?.crew?.find((person) => person.job === "Director")?.name
    || (ko.created_by ?? []).map((person) => person.name).filter(Boolean).join(", ");
  const cast: CastMember[] = [...(ko.credits?.cast ?? [])]
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .slice(0, 8)
    .map((person) => ({ id: person.id, name: person.name ?? "", role: formatCreditRole(person.character), profilePath: person.profile_path }))
    .filter((person) => person.name);

  return {
    tmdbID: ko.id,
    kind,
    titleKO: pickKorean([localized, original, enLocalized, enOriginal]),
    titleEN: pickEnglish([enLocalized, enOriginal, original, localized]),
    year: date.length >= 4 ? date.slice(0, 4) : undefined,
    overview,
    tagline: (ko.tagline && ko.tagline.length > 0 ? ko.tagline : en.tagline) ?? "",
    posterPath: ko.poster_path || en.poster_path,
    genres: (ko.genres ?? en.genres ?? []).map((item) => item.name).filter((name): name is string => Boolean(name)),
    runtimeMinutes: ko.runtime ?? en.runtime ?? ko.episode_run_time?.[0] ?? en.episode_run_time?.[0],
    seasons: ko.number_of_seasons,
    episodes: ko.number_of_episodes,
    certification: certification(kind, ko) ?? certification(kind, en),
    director,
    homepage: ko.homepage || en.homepage || undefined,
    tmdbURL: `https://www.themoviedb.org/${kind}/${ko.id}?language=ko-KR`,
    imdbID: ko.external_ids?.imdb_id || ko.imdb_id || en.external_ids?.imdb_id,
    tmdbScore: ko.vote_average ?? 0,
    tmdbCount: ko.vote_count ?? 0,
    cast,
    availability: availability(ko["watch/providers"]),
    networks: (ko.networks ?? []).map((item) => item.name).filter((name): name is string => Boolean(name)),
    extraLinks: [],
    popularReviews: [],
  };
}

export async function fetchPopularReviews(kind: MediaKind, id: number, _titleKO = "", _titleEN = ""): Promise<PopularReview[]> {
  return fetchPopularReviewsInternal(kind, id);
}

export function watchaSearchURL(titleKO: string, titleEN: string): string {
  const query = pickKorean([titleKO, titleEN]) || titleEN || titleKO;
  return `https://pedia.watcha.com/ko-KR/search?query=${encodeURIComponent(query)}`;
}

function sortReviews(reviews: PopularReview[]): PopularReview[] {
  return [...reviews].sort((a, b) => {
    const ko = Number(containsHangul(b.content)) - Number(containsHangul(a.content));
    if (ko !== 0) return ko;
    return (b.rating ?? 0) - (a.rating ?? 0) || (b.likes ?? 0) - (a.likes ?? 0);
  });
}

interface ReviewItemDTO {
  id?: string;
  author?: string;
  content?: string;
  url?: string;
  author_details?: { username?: string; rating?: number };
}

function cleanReview(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function truncateReview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trim()}…`;
}

async function fetchTMDBReviews(kind: MediaKind, id: number): Promise<PopularReview[]> {
  const [ko, en] = await Promise.all([
    tmdb<{ results?: ReviewItemDTO[] }>(`/${kind}/${id}/reviews`, { language: "ko-KR", page: "1" }),
    tmdb<{ results?: ReviewItemDTO[] }>(`/${kind}/${id}/reviews`, { language: "en-US", page: "1" }),
  ]);
  const seen = new Set<string>();
  const reviews: PopularReview[] = [];
  for (const page of [ko, en]) {
    for (const item of page.results ?? []) {
      const content = cleanReview(item.content ?? "");
      if (content.length < 40 || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      reviews.push({
        id: `tmdb-${item.id}`,
        author: item.author ?? item.author_details?.username ?? "TMDB",
        content: truncateReview(content, 320),
        rating: item.author_details?.rating,
        source: "TMDB",
        url: item.url,
      });
    }
  }
  return sortReviews(reviews);
}

async function fetchPopularReviewsInternal(kind: MediaKind, id: number): Promise<PopularReview[]> {
  const reviews = await fetchTMDBReviews(kind, id);
  return sortReviews(reviews).slice(0, 5);
}

async function enrichOMDb(detail: TitleDetail): Promise<void> {
  if (!settings.hasOMDb || !detail.imdbID) return;
  try {
    const url = new URL("https://www.omdbapi.com/");
    url.searchParams.set("i", detail.imdbID);
    url.searchParams.set("apikey", settings.omdb);
    const data = await (await fetch(url)).json() as {
      Response?: string;
      imdbRating?: string;
      imdbVotes?: string;
      Ratings?: { Source?: string; Value?: string }[];
    };
    if (data.Response !== "True") return;
    const clean = (value?: string) => (value && value !== "N/A" ? value : undefined);
    detail.imdb = clean(data.imdbRating);
    detail.imdbVotes = clean(data.imdbVotes);
    detail.rottenTomatoes = clean(data.Ratings?.find((item) => item.Source === "Rotten Tomatoes")?.Value);
    detail.metacritic = clean(data.Ratings?.find((item) => item.Source === "Metacritic")?.Value);
  } catch {
    // optional
  }
}

async function enrichTVMaze(detail: TitleDetail): Promise<void> {
  if (detail.kind !== "tv") return;
  const query = detail.titleEN || detail.titleKO;
  if (!query) return;
  try {
    const url = new URL("https://api.tvmaze.com/search/shows");
    url.searchParams.set("q", query);
    const rows = await (await fetch(url)).json() as {
      show?: {
        name?: string;
        rating?: { average?: number };
        summary?: string;
        officialSite?: string;
        network?: { name?: string };
        webChannel?: { name?: string };
        externals?: { imdb?: string };
      };
    }[];
    const show = rows[0]?.show;
    if (!show) return;
    if (show.rating?.average) detail.tvmaze = show.rating.average.toFixed(1);
    if (!detail.imdbID && show.externals?.imdb) detail.imdbID = show.externals.imdb;
    const network = show.network?.name || show.webChannel?.name;
    if (network && !detail.networks.includes(network)) detail.networks.unshift(network);
    if (!detail.overview && show.summary) {
      detail.overview = show.summary.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    }
    if (show.officialSite && !detail.homepage) {
      detail.extraLinks.push({ name: "공식 사이트", url: show.officialSite });
    }
  } catch {
    // optional
  }
}

async function enrichWikipedia(detail: TitleDetail): Promise<void> {
  const query = detail.titleKO || detail.titleEN;
  if (!query) return;
  try {
    const searchURL = new URL("https://ko.wikipedia.org/w/api.php");
    searchURL.searchParams.set("action", "opensearch");
    searchURL.searchParams.set("search", query);
    searchURL.searchParams.set("limit", "8");
    searchURL.searchParams.set("namespace", "0");
    searchURL.searchParams.set("format", "json");
    searchURL.searchParams.set("origin", "*");
    const search = await (await fetch(searchURL)).json() as [string, string[], string[], string[]];
    const titles = search[1] ?? [];
    const hint = detail.kind === "movie" ? "영화" : "드라마";
    const title = titles.find((item) => item.includes(hint) || item.includes("시리즈")) ?? titles[0];
    if (!title) return;
    const summaryURL = `https://ko.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
    const summary = await (await fetch(summaryURL)).json() as { type?: string; extract?: string; content_urls?: { desktop?: { page?: string } } };
    if (summary.type === "disambiguation") return;
    const extract = summary.extract?.trim() ?? "";
    if (extract.length >= 40 && (!detail.overview || !/[\uAC00-\uD7A3]/.test(detail.overview))) {
      detail.overview = extract;
    }
    detail.wikipediaURL = summary.content_urls?.desktop?.page;
  } catch {
    // optional
  }
}

async function enrichKMDB(detail: TitleDetail): Promise<void> {
  if (detail.kind !== "movie" || !settings.hasKMDB) return;
  try {
    const entry = await lookupKMDB(detail.titleKO, detail.titleEN, detail.year, detail.director);
    if (!entry) return;
    detail.kmdbURL = entry.kmdbURL;
    if (!detail.certification && entry.rating) detail.certification = entry.rating;
    if (!detail.overview && entry.plot) detail.overview = entry.plot;
    if (!detail.posterPath && entry.posterURL) detail.posterPath = entry.posterURL;
  } catch {
    // optional — key may be pending approval or API may block browser CORS
  }
}

export function providerLink(name: string, title: string): string | undefined {
  const encoded = encodeURIComponent(title);
  const key = name.toLowerCase().replaceAll("＋", "+").replace(/\s+/g, " ").trim();
  const table: Record<string, string> = {
    netflix: `https://www.netflix.com/search?q=${encoded}`,
    watcha: `https://watcha.com/search?query=${encoded}`,
    wavve: `https://www.wavve.com/search?searchWord=${encoded}`,
    tving: `https://www.tving.com/search?keyword=${encoded}`,
    "disney plus": "https://www.disneyplus.com/ko-kr/search",
    "disney+": "https://www.disneyplus.com/ko-kr/search",
    "coupang play": `https://www.coupangplay.com/search?q=${encoded}`,
    "apple tv": `https://tv.apple.com/search?term=${encoded}`,
    "apple tv plus": `https://tv.apple.com/search?term=${encoded}`,
    "apple tv+": `https://tv.apple.com/search?term=${encoded}`,
    "amazon prime video": `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encoded}`,
    "prime video": `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encoded}`,
    youtube: `https://www.youtube.com/results?search_query=${encoded}`,
  };
  return table[key];
}
