const KEYS = {
  tmdb: "eodibwa.tmdbAPIKey",
  omdb: "eodibwa.omdbAPIKey",
  motn: "eodibwa.motnAPIKey",
  region: "eodibwa.region",
};

const DEFAULT_TMDB = import.meta.env.VITE_TMDB_KEY ?? "";
const DEFAULT_OMDB = import.meta.env.VITE_OMDB_KEY ?? "";
const DEFAULT_MOTN = import.meta.env.VITE_MOTN_KEY ?? "";

export const settings = {
  get tmdb(): string {
    return localStorage.getItem(KEYS.tmdb) ?? DEFAULT_TMDB;
  },
  set tmdb(value: string) {
    localStorage.setItem(KEYS.tmdb, value.trim());
  },
  get omdb(): string {
    return localStorage.getItem(KEYS.omdb) ?? DEFAULT_OMDB;
  },
  set omdb(value: string) {
    localStorage.setItem(KEYS.omdb, value.trim());
  },
  get motn(): string {
    return localStorage.getItem(KEYS.motn) ?? DEFAULT_MOTN;
  },
  set motn(value: string) {
    localStorage.setItem(KEYS.motn, value.trim());
  },
  get region(): string {
    return localStorage.getItem(KEYS.region) ?? "KR";
  },
  set region(value: string) {
    localStorage.setItem(KEYS.region, value);
  },
  get hasTMDB(): boolean {
    return this.tmdb.length > 0;
  },
  get hasOMDb(): boolean {
    return this.omdb.length > 0;
  },
  get hasMOTN(): boolean {
    return this.motn.length > 0;
  },
};
