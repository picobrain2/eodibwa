const KEYS = {
  tmdb: "eodibwa.tmdbAPIKey",
  omdb: "eodibwa.omdbAPIKey",
  region: "eodibwa.region",
};

export const settings = {
  get tmdb(): string {
    return localStorage.getItem(KEYS.tmdb) ?? "";
  },
  set tmdb(value: string) {
    localStorage.setItem(KEYS.tmdb, value.trim());
  },
  get omdb(): string {
    return localStorage.getItem(KEYS.omdb) ?? "";
  },
  set omdb(value: string) {
    localStorage.setItem(KEYS.omdb, value.trim());
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
};
