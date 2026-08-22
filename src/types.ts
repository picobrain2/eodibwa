export type MediaKind = "movie" | "tv";
export type MediaFilter = "all" | "movie" | "tv";

export type WatchOffer = "flatrate" | "free" | "ads" | "rent" | "buy";

export interface SearchHit {
  id: string;
  tmdbID: number;
  kind: MediaKind;
  titleKO: string;
  titleEN: string;
  year?: string;
  overview: string;
  posterPath?: string;
  voteAverage: number;
  voteCount: number;
  imdbID?: string;
  imdbVoteCount?: number;
  providerLogo?: string;
  providerName?: string;
  providerID?: number;
  inTheaters?: boolean;
  matchedPerson?: string;
  matchedPersonNames?: string[];
  matchedRole?: string;
}

export interface WatchProvider {
  providerID: number;
  name: string;
  logoPath?: string;
  offerType: WatchOffer;
}

export interface RegionAvailability {
  countryCode: string;
  justWatchURL?: string;
  providers: WatchProvider[];
}

export interface CastMember {
  id: number;
  name: string;
  role: string;
  profilePath?: string;
}

export interface TitleDetail {
  tmdbID: number;
  kind: MediaKind;
  titleKO: string;
  titleEN: string;
  year?: string;
  overview: string;
  tagline: string;
  posterPath?: string;
  genres: string[];
  runtimeMinutes?: number;
  seasons?: number;
  episodes?: number;
  certification?: string;
  director?: string;
  homepage?: string;
  tmdbURL: string;
  imdbID?: string;
  tmdbScore: number;
  tmdbCount: number;
  imdb?: string;
  imdbVotes?: string;
  rottenTomatoes?: string;
  metacritic?: string;
  tvmaze?: string;
  cast: CastMember[];
  availability: RegionAvailability[];
  networks: string[];
  extraLinks: { name: string; url: string }[];
  wikipediaURL?: string;
  popularReviews: PopularReview[];
  inTheaters?: boolean;
}

export interface PopularReview {
  id: string;
  author: string;
  content: string;
  translatedContent?: string;
  likes?: number;
  rating?: number;
  source: string;
  url?: string;
}

export const REGIONS: { code: string; name: string }[] = [
  { code: "KR", name: "한국" },
  { code: "US", name: "미국" },
  { code: "JP", name: "일본" },
  { code: "TW", name: "대만" },
  { code: "HK", name: "홍콩" },
  { code: "GB", name: "영국" },
];

export const OFFER_LABEL: Record<WatchOffer, string> = {
  flatrate: "구독",
  free: "무료",
  ads: "광고 포함 무료",
  rent: "대여",
  buy: "구매",
};

export function kindLabel(kind: MediaKind): string {
  return kind === "movie" ? "영화" : "시리즈";
}

export function posterURL(path?: string, size = "w185"): string | undefined {
  if (!path) return undefined;
  if (path.startsWith("http")) return path;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

export function runtimeText(detail: TitleDetail): string | undefined {
  if (detail.kind === "tv" && detail.seasons && detail.episodes) {
    return `시즌 ${detail.seasons} · ${detail.episodes}화`;
  }
  if (!detail.runtimeMinutes) return undefined;
  const hours = Math.floor(detail.runtimeMinutes / 60);
  const minutes = detail.runtimeMinutes % 60;
  if (hours && minutes) return `${hours}시간 ${minutes}분`;
  if (hours) return `${hours}시간`;
  return `${minutes}분`;
}

export function regionName(code: string): string {
  return REGIONS.find((item) => item.code === code)?.name ?? code;
}
