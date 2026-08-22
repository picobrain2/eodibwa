import { hangulSpaceVariants, isStrongMatch, pickEnglish, pickKorean, relevance, searchVariants } from "./lang";
import { settings } from "./settings";
import type { CastMember, MediaKind, RegionAvailability, SearchHit, TitleDetail, WatchOffer, WatchProvider } from "./types";

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

function yearOf(item: SearchItem): string | undefined {
  const date = item.release_date || item.first_air_date || "";
  return date.length >= 4 ? date.slice(0, 4) : undefined;
}

function toHit(item: SearchItem, english?: SearchItem): SearchHit | undefined {
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
  };
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

export async function searchTitles(query: string): Promise<SearchHit[]> {
  let hits = await collect(searchVariants(query));
  const strong = hits.some((hit) => isStrongMatch([hit.titleKO, hit.titleEN], query));
  if (!strong) {
    const extra = hangulSpaceVariants(query);
    if (extra.length) {
      const more = await collect(extra);
      const seen = new Set(hits.map((hit) => hit.id));
      hits = hits.concat(more.filter((hit) => !seen.has(hit.id)));
    }
  }
  return hits.sort((a, b) => {
    const left = relevance([a.titleKO, a.titleEN], query);
    const right = relevance([b.titleKO, b.titleEN], query);
    if (left !== right) return right - left;
    return b.voteCount - a.voteCount;
  });
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
  };

  await Promise.all([
    enrichOMDb(detail),
    enrichTVMaze(detail),
    enrichWikipedia(detail),
  ]);
  return detail;
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
