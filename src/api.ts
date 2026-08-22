import { containsHangul, hangulSpaceVariants, isStrongMatch, pickEnglish, pickKorean, relevance, searchVariants } from "./lang";
import { settings } from "./settings";
import { loadNowPlaying } from "./theaters";
import type { CastMember, MediaKind, PopularReview, RegionAvailability, SearchHit, TitleDetail, WatchOffer, WatchProvider } from "./types";

const TMDB = "https://api.themoviedb.org/3";

async function tmdb<T>(path: string, query: Record<string, string> = {}): Promise<T> {
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
}

interface CreditItem extends SearchItem {
  character?: string;
  job?: string;
}

const PERSON_MATCH_MIN = 60;
const MAX_PERSON_LOOKUPS = 2;
const DIRECTOR_JOBS = new Set(["Director", "Creator", "Co-Director"]);

function yearOf(item: SearchItem): string | undefined {
  const date = item.release_date || item.first_air_date || "";
  return date.length >= 4 ? date.slice(0, 4) : undefined;
}

function toHit(
  item: SearchItem,
  english?: SearchItem,
  extras?: Pick<SearchHit, "matchedPerson" | "matchedPersonNames" | "matchedRole">,
): SearchHit | undefined {
  const kind = item.media_type === "movie" || item.media_type === "tv" ? item.media_type : undefined;
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
}

function addPersonNames(map: Map<number, PersonCandidate>, person: PersonSearchItem): void {
  const row = map.get(person.id) ?? { id: person.id, names: [] };
  for (const name of [person.name, person.original_name]) {
    if (name && !row.names.includes(name)) row.names.push(name);
  }
  map.set(person.id, row);
}

function personMatchScore(names: string[], queries: string[]): number {
  return Math.max(0, ...queries.map((query) => relevance(names, query)));
}

async function searchPersonFilmography(queries: string[]): Promise<SearchHit[]> {
  const pages = await Promise.all(
    queries.flatMap((query) => [
      tmdb<{ results: PersonSearchItem[] }>("/search/person", { query, language: "ko-KR", include_adult: "false", page: "1" }),
      tmdb<{ results: PersonSearchItem[] }>("/search/person", { query, language: "en-US", include_adult: "false", page: "1" }),
    ]),
  );

  const peopleByID = new Map<number, PersonCandidate>();
  for (const page of pages) {
    for (const person of page.results ?? []) addPersonNames(peopleByID, person);
  }

  const matched = [...peopleByID.values()]
    .map((person) => ({ person, score: personMatchScore(person.names, queries) }))
    .filter((row) => row.score >= PERSON_MATCH_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PERSON_LOOKUPS);

  if (!matched.length) return [];

  const creditPages = await Promise.all(
    matched.map(({ person }) =>
      tmdb<{ cast?: CreditItem[]; crew?: CreditItem[] }>(`/person/${person.id}/combined_credits`, { language: "ko-KR" }),
    ),
  );

  const seen = new Set<string>();
  const hits: SearchHit[] = [];

  for (let index = 0; index < matched.length; index++) {
    const { person } = matched[index];
    const personName = pickKorean(person.names) || person.names[0] || "";
    const credits = creditPages[index];

    for (const item of credits.cast ?? []) {
      const hit = toHit(item, undefined, {
        matchedPerson: personName,
        matchedPersonNames: person.names,
        matchedRole: item.character?.trim() || "출연",
      });
      if (!hit || seen.has(hit.id)) continue;
      seen.add(hit.id);
      hits.push(hit);
    }

    for (const item of credits.crew ?? []) {
      if (!item.job || !DIRECTOR_JOBS.has(item.job)) continue;
      const hit = toHit(item, undefined, {
        matchedPerson: personName,
        matchedPersonNames: person.names,
        matchedRole: "감독",
      });
      if (!hit || seen.has(hit.id)) continue;
      seen.add(hit.id);
      hits.push(hit);
    }
  }

  return hits.sort((a, b) => b.voteCount - a.voteCount);
}

function compareSearchHits(a: SearchHit, b: SearchHit, query: string): number {
  const left = searchHitScore(a, query);
  const right = searchHitScore(b, query);
  if (left !== right) return right - left;
  return popularityVotes(b) - popularityVotes(a);
}

function mergeHits(primary: SearchHit[], extra: SearchHit[]): SearchHit[] {
  const seen = new Set(primary.map((hit) => hit.id));
  const merged = [...primary];
  for (const hit of extra) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    merged.push(hit);
  }
  return merged;
}

function searchHitScore(hit: SearchHit, query: string): number {
  const titleScore = relevance([hit.titleKO, hit.titleEN], query);
  const personScore = hit.matchedPersonNames
    ? relevance(hit.matchedPersonNames, query)
    : hit.matchedPerson
      ? relevance([hit.matchedPerson], query)
      : 0;
  if (titleScore >= 80) return titleScore * 1000 + popularityVotes(hit);
  if (personScore >= PERSON_MATCH_MIN) return personScore * 100 + titleScore + popularityVotes(hit) / 1000;
  return titleScore * 10 + popularityVotes(hit) / 1000;
}

async function searchOnce(query: string): Promise<SearchHit[]> {
  const [ko, en] = await Promise.all([
    tmdb<{ results: SearchItem[] }>("/search/multi", { query, language: "ko-KR", include_adult: "false", page: "1" }),
    tmdb<{ results: SearchItem[] }>("/search/multi", { query, language: "en-US", include_adult: "false", page: "1" }),
  ]);
  const enByID = new Map(en.results.filter((item) => item.media_type === "movie" || item.media_type === "tv").map((item) => [`${item.media_type}-${item.id}`, item]));
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const item of [...ko.results, ...en.results]) {
    const key = `${item.media_type}-${item.id}`;
    if (seen.has(key)) continue;
    const hit = toHit(item, enByID.get(key));
    if (!hit) continue;
    seen.add(key);
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

async function enrichSearchHitsWithImdb(hits: SearchHit[]): Promise<SearchHit[]> {
  if (!settings.hasOMDb || !hits.length) return hits;

  return mapInBatches(hits, ENRICH_BATCH, async (hit) => {
    const imdbID = hit.imdbID ?? await fetchImdbId(hit.kind, hit.tmdbID);
    if (!imdbID) return hit;
    const imdbVoteCount = await fetchImdbVoteCount(imdbID);
    if (imdbVoteCount === undefined) return { ...hit, imdbID };
    return { ...hit, imdbID, imdbVoteCount };
  });
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
  const pending = unique.filter((hit) => !localizedTitleCache.has(hit.id));

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

export async function searchTitles(query: string): Promise<SearchHit[]> {
  const variants = searchVariants(query);
  let [hits, personHits] = await Promise.all([
    collect(variants),
    searchPersonFilmography(variants),
  ]);

  const strong = hits.some((hit) => isStrongMatch([hit.titleKO, hit.titleEN], query));
  if (!strong) {
    const extra = hangulSpaceVariants(query);
    if (extra.length) {
      const more = await collect(extra);
      hits = mergeHits(hits, more);
    }
  }

  hits = mergeHits(hits, personHits);
  hits = await enrichSearchHitsWithImdb(hits);

  return hits.sort((a, b) => compareSearchHits(a, b, query));
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

export async function fetchDetail(kind: MediaKind, id: number): Promise<TitleDetail> {
  const append = kind === "movie" ? "watch/providers,external_ids,credits,release_dates" : "watch/providers,external_ids,credits,content_ratings";
  const [ko, en] = await Promise.all([
    tmdb<DetailDTO>(`/${kind}/${id}`, { language: "ko-KR", append_to_response: append }),
    tmdb<DetailDTO>(`/${kind}/${id}`, { language: "en-US" }),
  ]);
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
    .map((person) => ({ id: person.id, name: person.name ?? "", role: person.character ?? "", profilePath: person.profile_path }))
    .filter((person) => person.name);

  const detail: TitleDetail = {
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

  await Promise.all([
    enrichOMDb(detail),
    enrichTVMaze(detail),
    enrichWikipedia(detail),
  ]);

  if (kind === "movie") {
    const playing = await loadNowPlaying(settings.region);
    detail.inTheaters = playing.has(id);
  }

  return detail;
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
